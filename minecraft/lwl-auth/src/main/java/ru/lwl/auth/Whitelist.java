package ru.lwl.auth;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonParseException;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.concurrent.Executor;

/**
 * Вайтлист по никам: config/lwl-auth/whitelist.json.
 * Стандартный вайтлист Minecraft хранит UUID лицензии, а у игроков с пиратки
 * (и у всех, если включён keepOfflineUuid) UUID другой — поэтому он их не пускает.
 * Здесь проверяется только ник (без учёта регистра); подделать ник не даёт сам LWL Auth.
 */
public final class Whitelist {
	private static final Logger LOGGER = LoggerFactory.getLogger("LWL Auth");
	private static final Gson GSON = new GsonBuilder().setPrettyPrinting().disableHtmlEscaping().create();

	private static final class Data {
		boolean enabled;
		TreeMap<String, Entry> players = new TreeMap<>();
	}

	public static final class Entry {
		public String name;
		public long addedAt;
		public String addedBy;

		Entry() {
		}

		Entry(String name, String addedBy) {
			this.name = name;
			this.addedBy = addedBy;
			this.addedAt = System.currentTimeMillis();
		}
	}

	private final Path file;
	private final Executor io;
	private Data data = new Data();

	public Whitelist(Path dir, Executor io) {
		this.file = dir.resolve("whitelist.json");
		this.io = io;
		if (Files.exists(file)) {
			try {
				Data loaded = GSON.fromJson(Files.readString(file, StandardCharsets.UTF_8), Data.class);
				if (loaded != null) {
					data = loaded;
					if (data.players == null) {
						data.players = new TreeMap<>();
					}
				}
			} catch (IOException | JsonParseException e) {
				// Вайтлист — это защита: сломанный файл не должен тихо открыть сервер для всех.
				throw new IllegalStateException("Файл " + file + " повреждён: " + e.getMessage()
					+ ". Восстановите его из whitelist.json.bak или удалите вручную.", e);
			}
		}
		LOGGER.info("Вайтлист LWL: {}, ников: {}", data.enabled ? "включён" : "выключен", data.players.size());
	}

	public synchronized boolean enabled() {
		return data.enabled;
	}

	public synchronized void setEnabled(boolean enabled) {
		data.enabled = enabled;
		save();
	}

	public synchronized boolean contains(String name) {
		return data.players.containsKey(AuthStore.key(name));
	}

	/** false — ник уже был в списке. */
	public synchronized boolean add(String name, String addedBy) {
		if (contains(name)) {
			return false;
		}
		data.players.put(AuthStore.key(name), new Entry(name, addedBy));
		save();
		return true;
	}

	public synchronized boolean remove(String name) {
		boolean removed = data.players.remove(AuthStore.key(name)) != null;
		if (removed) {
			save();
		}
		return removed;
	}

	public synchronized List<String> names() {
		List<String> names = new ArrayList<>();
		for (Map.Entry<String, Entry> e : data.players.entrySet()) {
			names.add(e.getValue().name != null ? e.getValue().name : e.getKey());
		}
		return names;
	}

	/** Можно ли зайти с этим ником (true, если вайтлист выключен). */
	public boolean allows(String name) {
		return !enabled() || contains(name);
	}

	private void save() {
		String json = GSON.toJson(data);
		io.execute(() -> write(json));
	}

	private synchronized void write(String json) {
		Path tmp = file.resolveSibling(file.getFileName() + ".tmp");
		try {
			Files.createDirectories(file.getParent());
			Files.writeString(tmp, json, StandardCharsets.UTF_8);
			if (Files.exists(file)) {
				Files.copy(file, file.resolveSibling(file.getFileName() + ".bak"), StandardCopyOption.REPLACE_EXISTING);
			}
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
