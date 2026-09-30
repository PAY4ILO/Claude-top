package ru.lwl.skins;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonParseException;
import com.google.gson.reflect.TypeToken;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.IOException;
import java.lang.reflect.Type;
import java.nio.charset.StandardCharsets;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.Locale;
import java.util.Map;
import java.util.TreeMap;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executor;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Хранилище на диске сервера (config/lwl-skins/):
 * players.json — выбранные игроками скины, cache.json — скины лицензионных ников.
 * Ключ — ник в нижнем регистре. Файлы пишутся целиком через временный файл,
 * чтобы при сбое не остался обрезанный JSON.
 */
public final class SkinStore {
	private static final Logger LOGGER = LoggerFactory.getLogger("LWL Skins");
	private static final Gson GSON = new GsonBuilder().setPrettyPrinting().disableHtmlEscaping().create();
	private static final Type PLAYERS_TYPE = new TypeToken<TreeMap<String, PlayerSkin>>() {}.getType();
	private static final Type CACHE_TYPE = new TypeToken<TreeMap<String, CachedNick>>() {}.getType();

	/** Скин, который игроку поставили командой. */
	public static final class PlayerSkin {
		public String name;
		/** "nick" или "url". */
		public String source;
		/** Ник или ссылка, из которых взят скин. */
		public String input;
		public boolean slim;
		public String value;
		public String signature;
		public long updatedAt;

		public PlayerSkin() {
		}

		public PlayerSkin(String name, String source, String input, boolean slim, Skin skin) {
			this.name = name;
			this.source = source;
			this.input = input;
			this.slim = slim;
			this.value = skin.value();
			this.signature = skin.signature();
			this.updatedAt = System.currentTimeMillis();
		}

		public Skin skin() {
			return new Skin(value, signature);
		}

		boolean isValid() {
			return value != null && signature != null && source != null;
		}
	}

	/** Результат поиска лицензионного ника. value == null — такого аккаунта нет. */
	public static final class CachedNick {
		public String value;
		public String signature;
		public long fetchedAt;

		public CachedNick() {
		}

		CachedNick(Skin skin) {
			if (skin != null) {
				value = skin.value();
				signature = skin.signature();
			}
			fetchedAt = System.currentTimeMillis();
		}

		public Skin skin() {
			return value == null || signature == null ? null : new Skin(value, signature);
		}
	}

	private final Path playersFile;
	private final Path cacheFile;
	private final Executor io;
	private final Map<String, PlayerSkin> players = new ConcurrentHashMap<>();
	private final Map<String, CachedNick> cache = new ConcurrentHashMap<>();
	private final AtomicBoolean playersDirty = new AtomicBoolean();
	private final AtomicBoolean cacheDirty = new AtomicBoolean();

	public SkinStore(Path dir, Executor io) {
		this.playersFile = dir.resolve("players.json");
		this.cacheFile = dir.resolve("cache.json");
		this.io = io;
		try {
			Files.createDirectories(dir);
		} catch (IOException e) {
			LOGGER.error("Не удалось создать папку {}: {}", dir, e.getMessage());
		}
		Map<String, PlayerSkin> loadedPlayers = read(playersFile, PLAYERS_TYPE);
		loadedPlayers.forEach((key, entry) -> {
			if (entry != null && entry.isValid()) {
				players.put(key(key), entry);
			}
		});
		Map<String, CachedNick> loadedCache = read(cacheFile, CACHE_TYPE);
		loadedCache.forEach((key, entry) -> {
			if (entry != null) {
				cache.put(key(key), entry);
			}
		});
		LOGGER.info("Скинов игроков: {}, ников в кеше: {}", players.size(), cache.size());
	}

	public static String key(String name) {
		return name.toLowerCase(Locale.ROOT);
	}

	public PlayerSkin get(String playerName) {
		return players.get(key(playerName));
	}

	public void put(PlayerSkin entry) {
		players.put(key(entry.name), entry);
		savePlayersLater();
	}

	public boolean remove(String playerName) {
		boolean removed = players.remove(key(playerName)) != null;
		if (removed) {
			savePlayersLater();
		}
		return removed;
	}

	public CachedNick cached(String nick) {
		return cache.get(key(nick));
	}

	public void cache(String nick, Skin skin) {
		cache.put(key(nick), new CachedNick(skin));
		cacheDirty.set(true);
		io.execute(this::flushCache);
	}

	private void savePlayersLater() {
		playersDirty.set(true);
		io.execute(this::flushPlayers);
	}

	/** Дописывает всё несохранённое. Вызывается при остановке сервера. */
	public void flush() {
		flushPlayers();
		flushCache();
	}

	private synchronized void flushPlayers() {
		if (playersDirty.getAndSet(false)) {
			write(playersFile, new TreeMap<>(players));
		}
	}

	private synchronized void flushCache() {
		if (cacheDirty.getAndSet(false)) {
			write(cacheFile, new TreeMap<>(cache));
		}
	}

	private static <T> Map<String, T> read(Path file, Type type) {
		if (!Files.exists(file)) {
			return Map.of();
		}
		try {
			Map<String, T> map = GSON.fromJson(Files.readString(file, StandardCharsets.UTF_8), type);
			return map == null ? Map.of() : map;
		} catch (IOException | JsonParseException e) {
			LOGGER.error("Файл {} повреждён ({}), начинаю с пустого. Старый сохранён как .broken", file, e.getMessage());
			try {
				Files.copy(file, file.resolveSibling(file.getFileName() + ".broken"), StandardCopyOption.REPLACE_EXISTING);
			} catch (IOException ignored) {
				// не страшно: главное — сервер запустится
			}
			return Map.of();
		}
	}

	private static void write(Path file, Object data) {
		Path tmp = file.resolveSibling(file.getFileName() + ".tmp");
		try {
			Files.writeString(tmp, GSON.toJson(data), StandardCharsets.UTF_8);
			try {
				Files.move(tmp, file, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
			} catch (AtomicMoveNotSupportedException e) {
				Files.move(tmp, file, StandardCopyOption.REPLACE_EXISTING);
			}
		} catch (IOException e) {
			LOGGER.error("Не удалось сохранить {}: {}", file, e.getMessage());
		}
	}
}
