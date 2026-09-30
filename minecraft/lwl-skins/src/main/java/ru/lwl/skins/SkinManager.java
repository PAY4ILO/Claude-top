package ru.lwl.skins;

import com.google.common.collect.LinkedHashMultimap;
import com.google.common.collect.Multimap;
import com.mojang.authlib.GameProfile;
import com.mojang.authlib.properties.Property;
import com.mojang.authlib.properties.PropertyMap;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerPlayer;
import org.jspecify.annotations.Nullable;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import ru.lwl.skins.mixin.PlayerAccessor;

import java.nio.file.Path;
import java.time.Duration;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

/**
 * Решает, какой скин должен быть у игрока, и ставит его.
 * Порядок: скин, выбранный командой → «родной» скин из лицензии (онлайн-режим)
 * → скин лицензионного аккаунта с таким же ником (если включено) → без скина.
 */
public final class SkinManager {
	private static final Logger LOGGER = LoggerFactory.getLogger("LWL Skins");
	private static volatile @Nullable SkinManager instance;

	private final MinecraftServer server;
	private final Path configFile;
	private volatile SkinConfig config;
	private final ExecutorService network;
	private final ExecutorService io;
	private final SkinStore store;
	private final SkinFetcher fetcher;
	/** Текстуры, с которыми игрок пришёл сам (лицензия / мод авторизации). */
	private final Map<UUID, Skin> original = new ConcurrentHashMap<>();
	/** Один запрос на ник, сколько бы игроков его ни ждали. */
	private final Map<String, CompletableFuture<Optional<Skin>>> inflight = new ConcurrentHashMap<>();
	private final Map<UUID, Long> cooldowns = new ConcurrentHashMap<>();

	private SkinManager(MinecraftServer server, Path configDir) {
		this.server = server;
		this.configFile = configDir.resolve("lwl-skins.json");
		this.config = SkinConfig.load(configFile);
		this.network = Executors.newFixedThreadPool(2, Thread.ofPlatform().name("lwl-skins-net-", 0).daemon().factory());
		this.io = Executors.newSingleThreadExecutor(Thread.ofPlatform().name("lwl-skins-io").daemon().factory());
		this.store = new SkinStore(configDir.resolve("lwl-skins"), io);
		this.fetcher = new SkinFetcher(network, () -> this.config);
	}

	public static void start(MinecraftServer server, Path configDir) {
		instance = new SkinManager(server, configDir);
	}

	public static void stop() {
		SkinManager manager = instance;
		instance = null;
		if (manager != null) {
			manager.network.shutdownNow();
			manager.io.shutdown();
			try {
				manager.io.awaitTermination(5, TimeUnit.SECONDS);
			} catch (InterruptedException e) {
				Thread.currentThread().interrupt();
			}
			manager.store.flush();
		}
	}

	public static @Nullable SkinManager get() {
		return instance;
	}

	public SkinConfig config() {
		return config;
	}

	public void reloadConfig() {
		config = SkinConfig.load(configFile);
	}

	public SkinStore store() {
		return store;
	}

	public MinecraftServer server() {
		return server;
	}

	// ---------- вход на сервер ----------

	/** Какой скин поставить при входе. Пусто — оставить профиль как есть. */
	public CompletableFuture<Optional<Skin>> resolveForLogin(GameProfile profile) {
		Skin own = texturesOf(profile);
		if (own != null) {
			original.put(profile.id(), own);
		} else {
			original.remove(profile.id());
		}
		SkinStore.PlayerSkin chosen = store.get(profile.name());
		if (chosen != null) {
			return CompletableFuture.completedFuture(Optional.of(chosen.skin()));
		}
		if (own != null) {
			return CompletableFuture.completedFuture(Optional.empty());
		}
		return nicknameSkin(profile.name());
	}

	/** Страховка: если при входе скин не успел загрузиться, ставим его, когда придёт. */
	public void onJoin(ServerPlayer player) {
		GameProfile profile = player.getGameProfile();
		SkinStore.PlayerSkin chosen = store.get(profile.name());
		CompletableFuture<Optional<Skin>> wanted;
		if (chosen != null) {
			wanted = CompletableFuture.completedFuture(Optional.of(chosen.skin()));
		} else if (texturesOf(profile) != null) {
			return;
		} else {
			wanted = nicknameSkin(profile.name());
		}
		UUID id = player.getUUID();
		wanted.whenComplete((skin, error) -> {
			if (error == null && skin.isPresent()) {
				server.execute(() -> {
					ServerPlayer online = server.getPlayerList().getPlayer(id);
					if (online != null && !skin.get().equals(texturesOf(online.getGameProfile()))) {
						apply(online, skin.get());
					}
				});
			}
		});
	}

	/** Скин лицензии с таким ником, с кешем. Ошибки сети превращаются в «без скина». */
	public CompletableFuture<Optional<Skin>> nicknameSkin(String nick) {
		if (!config.skinFromNickname || !SkinFetcher.isValidNickname(nick)) {
			return CompletableFuture.completedFuture(Optional.empty());
		}
		SkinStore.CachedNick cached = store.cached(nick);
		long maxAge = Duration.ofHours(config.nicknameCacheHours).toMillis();
		if (cached != null && System.currentTimeMillis() - cached.fetchedAt < maxAge) {
			return CompletableFuture.completedFuture(Optional.ofNullable(cached.skin()));
		}
		return fetchNickname(nick).handle((skin, error) -> {
			if (error != null) {
				LOGGER.warn("Скин для {} не получен: {}", nick, SkinException.userMessage(error));
				// старый кеш лучше, чем ничего
				return cached == null ? Optional.<Skin>empty() : Optional.ofNullable(cached.skin());
			}
			return skin;
		});
	}

	/** Свежий запрос к Mojang (кеш обновляется). */
	public CompletableFuture<Optional<Skin>> fetchNickname(String nick) {
		String key = SkinStore.key(nick);
		CompletableFuture<Optional<Skin>> result = new CompletableFuture<>();
		CompletableFuture<Optional<Skin>> running = inflight.putIfAbsent(key, result);
		if (running != null) {
			return running;
		}
		fetcher.premiumSkin(nick).whenComplete((skin, error) -> {
			inflight.remove(key, result);
			if (error != null) {
				result.completeExceptionally(error);
			} else {
				store.cache(nick, skin.orElse(null));
				result.complete(skin);
			}
		});
		return result;
	}

	public CompletableFuture<Skin> fetchUrl(String url, boolean slim) {
		return fetcher.skinFromUrl(url, slim);
	}

	// ---------- смена скина ----------

	/** Запоминает скин игрока и, если он в сети, сразу показывает всем. Только из потока сервера. */
	public void setSkin(String playerName, SkinStore.PlayerSkin entry) {
		store.put(entry);
		ServerPlayer player = server.getPlayerList().getPlayer(playerName);
		if (player != null) {
			apply(player, entry.skin());
		}
	}

	/**
	 * Сбрасывает выбранный скин. Возвращает future, который завершается, когда
	 * у игрока в сети уже стоит скин по умолчанию. Только из потока сервера.
	 */
	public CompletableFuture<Void> clearSkin(String playerName) {
		store.remove(playerName);
		ServerPlayer player = server.getPlayerList().getPlayer(playerName);
		if (player == null) {
			return CompletableFuture.completedFuture(null);
		}
		UUID id = player.getUUID();
		Skin own = original.get(id);
		CompletableFuture<Optional<Skin>> fallback = own != null
			? CompletableFuture.completedFuture(Optional.of(own))
			: nicknameSkin(player.getGameProfile().name());
		return fallback.thenAcceptAsync(skin -> {
			ServerPlayer online = server.getPlayerList().getPlayer(id);
			if (online != null && store.get(playerName) == null) {
				apply(online, skin.orElse(null));
			}
		}, server);
	}

	/** Меняет профиль игрока и рассылает обновление. Только из потока сервера. */
	public void apply(ServerPlayer player, @Nullable Skin skin) {
		GameProfile profile = withSkin(player.getGameProfile(), skin);
		((PlayerAccessor) player).lwlSkins$setGameProfile(profile);
		SkinRefresher.refresh(player);
	}

	/** Сейчас на игроке: выбранный скин или то, с чем он пришёл. */
	public @Nullable Skin current(ServerPlayer player) {
		return texturesOf(player.getGameProfile());
	}

	// ---------- кулдаун ----------

	/** Сколько секунд ещё ждать; 0 — можно. */
	public long cooldownLeft(UUID player) {
		Long until = cooldowns.get(player);
		long left = until == null ? 0 : until - System.currentTimeMillis();
		return left <= 0 ? 0 : (left + 999) / 1000;
	}

	public void startCooldown(UUID player) {
		if (config.commandCooldownSeconds > 0) {
			cooldowns.put(player, System.currentTimeMillis() + config.commandCooldownSeconds * 1000L);
		}
	}

	// ---------- профиль ----------

	public static @Nullable Skin texturesOf(GameProfile profile) {
		for (Property property : profile.properties().get(Skin.PROPERTY)) {
			if (property.hasSignature()) {
				return new Skin(property.value(), property.signature());
			}
		}
		return null;
	}

	/** Копия профиля с другими текстурами (или без них). Остальные свойства сохраняются. */
	public static GameProfile withSkin(GameProfile profile, @Nullable Skin skin) {
		Multimap<String, Property> props = LinkedHashMultimap.create(profile.properties());
		props.removeAll(Skin.PROPERTY);
		if (skin != null) {
			props.put(Skin.PROPERTY, skin.toProperty());
		}
		return new GameProfile(profile.id(), profile.name(), new PropertyMap(props));
	}
}
