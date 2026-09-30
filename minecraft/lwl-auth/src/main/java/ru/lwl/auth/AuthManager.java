package ru.lwl.auth;

import net.minecraft.ChatFormatting;
import net.minecraft.network.chat.Component;
import net.minecraft.network.protocol.game.ClientboundClearTitlesPacket;
import net.minecraft.network.protocol.game.ClientboundSetActionBarTextPacket;
import net.minecraft.network.protocol.game.ClientboundSetSubtitleTextPacket;
import net.minecraft.network.protocol.game.ClientboundSetTitleTextPacket;
import net.minecraft.network.protocol.game.ClientboundSetTitlesAnimationPacket;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.phys.Vec3;
import org.jspecify.annotations.Nullable;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

/**
 * Кто вошёл, а кто ещё нет.
 * Лицензия подтверждается при входе через сервер сессий Mojang (см. миксин логина),
 * остальные после входа в мир «заморожены», пока не введут /login или /register.
 */
public final class AuthManager {
	private static final Logger LOGGER = LoggerFactory.getLogger("LWL Auth");
	private static final Set<String> WEAK_PASSWORDS = Set.of(
		"123456", "1234567", "12345678", "123456789", "1234567890", "111111", "000000", "123123",
		"qwerty", "qwerty123", "йцукен", "password", "password1", "пароль", "minecraft", "abc123");
	private static volatile @Nullable AuthManager instance;

	public enum Mode {
		/** Ник закреплён за лицензией: вход через Mojang, без пароля. */
		PREMIUM,
		/** Вход по паролю. */
		PASSWORD
	}

	/** Игрок в мире, который ещё не ввёл пароль. */
	private static final class Pending {
		final Vec3 position;
		final float yRot;
		final float xRot;
		final long joinedAt = System.currentTimeMillis();
		int attempts;
		boolean checking;
		int lastReminder;

		Pending(ServerPlayer player) {
			this.position = player.position();
			this.yRot = player.getYRot();
			this.xRot = player.getXRot();
		}
	}

	private record Session(String ip, long until) {
	}

	private final MinecraftServer server;
	private final Path configFile;
	private volatile AuthConfig config;
	private final ExecutorService network;
	private final ExecutorService hashing;
	private final ExecutorService io;
	private final AuthStore store;
	private final Whitelist whitelist;
	private final PremiumLookup lookup;

	private final Set<UUID> authenticated = ConcurrentHashMap.newKeySet();
	private final Map<UUID, Pending> pending = new ConcurrentHashMap<>();
	/** Ник → момент, когда Mojang подтвердил лицензию (живёт до входа в мир). */
	private final Map<String, Long> premiumVerified = new ConcurrentHashMap<>();
	private final Map<String, Session> sessions = new ConcurrentHashMap<>();
	private final Map<String, Long> lockouts = new ConcurrentHashMap<>();
	private int ticks;

	private AuthManager(MinecraftServer server, Path configDir) {
		this.server = server;
		this.configFile = configDir.resolve("lwl-auth.json");
		this.config = AuthConfig.load(configFile);
		this.network = Executors.newFixedThreadPool(2, Thread.ofPlatform().name("lwl-auth-net-", 0).daemon().factory());
		this.hashing = Executors.newFixedThreadPool(2, Thread.ofPlatform().name("lwl-auth-hash-", 0).daemon().factory());
		this.io = Executors.newSingleThreadExecutor(Thread.ofPlatform().name("lwl-auth-io").daemon().factory());
		this.store = new AuthStore(configDir.resolve("lwl-auth"), io);
		this.whitelist = new Whitelist(configDir.resolve("lwl-auth"), io);
		this.lookup = new PremiumLookup(network, () -> this.config.mojangTimeoutSeconds);
		if (server.usesAuthentication()) {
			LOGGER.warn("Сервер в online-mode=true: туда и так пускают только лицензию, LWL Auth ничего не делает.");
		}
		if (server.isUsingWhitelist()) {
			LOGGER.warn("В server.properties включён white-list=true. Стандартный вайтлист сверяет UUID лицензии "
				+ "и не пускает игроков с пиратки. Выключите его (/whitelist off) и пользуйтесь /wl из LWL Auth.");
		}
	}

	public static void start(MinecraftServer server, Path configDir) {
		instance = new AuthManager(server, configDir);
	}

	public static void stop() {
		AuthManager manager = instance;
		instance = null;
		if (manager != null) {
			manager.network.shutdownNow();
			manager.hashing.shutdownNow();
			manager.io.shutdown();
			try {
				manager.io.awaitTermination(5, TimeUnit.SECONDS);
			} catch (InterruptedException e) {
				Thread.currentThread().interrupt();
			}
			manager.store.flush();
		}
	}

	public static @Nullable AuthManager get() {
		return instance;
	}

	public AuthConfig config() {
		return config;
	}

	public void reloadConfig() {
		config = AuthConfig.load(configFile);
	}

	public AuthStore store() {
		return store;
	}

	public Whitelist whitelist() {
		return whitelist;
	}

	/** Причина отказа, если ника нет во включённом вайтлисте; иначе null. */
	public @Nullable Component whitelistRejection(String name) {
		return whitelist.allows(name) ? null : Component.literal(config.whitelistMessage);
	}

	/** Включает вайтлист и сразу добавляет тех, кто сейчас в игре, — чтобы никого не выкинуло. */
	public List<String> enableWhitelist(String by) {
		List<String> added = new java.util.ArrayList<>();
		for (ServerPlayer player : server.getPlayerList().getPlayers()) {
			String name = player.getGameProfile().name();
			if (whitelist.add(name, by)) {
				added.add(name);
			}
		}
		whitelist.setEnabled(true);
		return added;
	}

	/** Убирает ник из вайтлиста; если вайтлист включён, игрока выкидывает. */
	public boolean removeFromWhitelist(String name) {
		boolean removed = whitelist.remove(name);
		if (removed && whitelist.enabled()) {
			kickIfOnline(name, config.whitelistMessage);
		}
		return removed;
	}

	public MinecraftServer server() {
		return server;
	}

	/** В online-mode мод ничего не делает: там уже всё проверил Mojang. */
	public boolean enabled() {
		return !server.usesAuthentication();
	}

	// ---------- вход на сервер (поток сети) ----------

	/** Как пускать игрока с этим ником. */
	public CompletableFuture<Mode> decideMode(String name) {
		AuthStore.Account account = store.get(name);
		if (account != null) {
			if (Boolean.TRUE.equals(account.premium)) {
				return CompletableFuture.completedFuture(config.premiumAutoLogin ? Mode.PREMIUM : Mode.PASSWORD);
			}
			if (Boolean.FALSE.equals(account.premium) || account.passwordHash != null) {
				// У ника уже есть пароль — он принадлежит тому, кто его завёл, даже если
				// позже кто-то купил лицензию с таким же ником.
				return CompletableFuture.completedFuture(Mode.PASSWORD);
			}
		}
		if (!config.premiumAutoLogin || !PremiumLookup.couldBePremium(name)) {
			return CompletableFuture.completedFuture(Mode.PASSWORD);
		}
		AuthStore.PremiumCheck cached = store.premiumCheck(name);
		long maxAge = Duration.ofHours(config.premiumCacheHours).toMillis();
		if (cached != null && System.currentTimeMillis() - cached.checkedAt < maxAge) {
			return CompletableFuture.completedFuture(cached.premium ? Mode.PREMIUM : Mode.PASSWORD);
		}
		return lookup.exists(name).handle((exists, error) -> {
			if (error != null) {
				LOGGER.warn("Mojang не ответил про ник {} ({}), вход по паролю", name, error.getMessage());
				if (cached != null) {
					return cached.premium ? Mode.PREMIUM : Mode.PASSWORD;
				}
				return Mode.PASSWORD;
			}
			store.cachePremium(name, exists);
			return exists ? Mode.PREMIUM : Mode.PASSWORD;
		});
	}

	/** Mojang подтвердил, что игрок — владелец лицензии с этим ником. */
	public void markPremiumVerified(String name) {
		premiumVerified.put(AuthStore.key(name), System.currentTimeMillis());
	}

	// ---------- игрок в мире (поток сервера) ----------

	public boolean isAuthenticated(ServerPlayer player) {
		return !enabled() || authenticated.contains(player.getUUID());
	}

	/** Можно ли пускать ещё одно подключение с этим ником (защита от выкидывания вошедшего игрока). */
	public boolean isOnlineAndLoggedIn(String name) {
		ServerPlayer online = server.getPlayerList().getPlayer(name);
		return online != null && authenticated.contains(online.getUUID());
	}

	public void onJoin(ServerPlayer player) {
		if (!enabled()) {
			return;
		}
		String name = player.getGameProfile().name();
		String key = AuthStore.key(name);
		String ip = player.getIpAddress();

		Long verifiedAt = premiumVerified.remove(key);
		if (verifiedAt != null && System.currentTimeMillis() - verifiedAt < 120_000) {
			store.update(name, account -> {
				account.name = name;
				account.premium = Boolean.TRUE;
				account.lastLoginAt = System.currentTimeMillis();
				if (account.registeredAt == 0) {
					account.registeredAt = account.lastLoginAt;
				}
				return account;
			});
			authenticate(player, Component.literal("Вход по лицензии — пароль не нужен. Приятной игры!"));
			return;
		}

		Long lockedUntil = lockouts.get(ip);
		if (lockedUntil != null && lockedUntil > System.currentTimeMillis()) {
			long seconds = (lockedUntil - System.currentTimeMillis() + 999) / 1000;
			player.connection.disconnect(Component.literal("Слишком много неверных паролей. Попробуйте через " + seconds + " сек."));
			return;
		}

		AuthStore.Account account = store.get(name);
		Session session = sessions.remove(key);
		if (session != null && account != null && account.passwordHash != null
			&& session.ip().equals(ip) && session.until() > System.currentTimeMillis()) {
			authenticate(player, Component.literal("С возвращением! Вы недавно входили с этого устройства — пароль не нужен."));
			return;
		}

		pending.put(player.getUUID(), new Pending(player));
		boolean registered = account != null && account.passwordHash != null;
		int stay = config.loginTimeoutSeconds * 20;
		player.connection.send(new ClientboundSetTitlesAnimationPacket(10, stay, 10));
		player.connection.send(new ClientboundSetTitleTextPacket(Component.literal(registered ? "Вход" : "Регистрация").withStyle(ChatFormatting.GOLD)));
		player.connection.send(new ClientboundSetSubtitleTextPacket(Component.literal(registered
			? "Введите /login <пароль>"
			: "Придумайте пароль: /register <пароль> <пароль>")));
		remind(player, registered);
	}

	public void onLeave(ServerPlayer player) {
		UUID id = player.getUUID();
		pending.remove(id);
		if (authenticated.remove(id) && config.sessionMinutes > 0) {
			AuthStore.Account account = store.get(player.getGameProfile().name());
			if (account != null && account.passwordHash != null) {
				sessions.put(AuthStore.key(player.getGameProfile().name()),
					new Session(player.getIpAddress(), System.currentTimeMillis() + config.sessionMinutes * 60_000L));
			}
		}
	}

	/** Раз в тик: таймаут на вход и подсказки. */
	public void tick() {
		if (pending.isEmpty()) {
			return;
		}
		ticks++;
		long now = System.currentTimeMillis();
		for (ServerPlayer player : List.copyOf(server.getPlayerList().getPlayers())) {
			Pending state = pending.get(player.getUUID());
			if (state == null) {
				continue;
			}
			long left = config.loginTimeoutSeconds - (now - state.joinedAt) / 1000;
			if (left <= 0) {
				pending.remove(player.getUUID());
				player.connection.disconnect(Component.literal("Время на вход вышло. Зайдите снова и введите пароль."));
				continue;
			}
			if (ticks % 20 == 0) {
				player.connection.send(new ClientboundSetActionBarTextPacket(Component.literal("Осталось " + left + " сек.").withStyle(ChatFormatting.YELLOW)));
				int reminder = (int) ((now - state.joinedAt) / 15_000);
				if (reminder != state.lastReminder) {
					state.lastReminder = reminder;
					AuthStore.Account account = store.get(player.getGameProfile().name());
					remind(player, account != null && account.passwordHash != null);
				}
			}
		}
	}

	/** Позиция, где игрок должен стоять, пока не войдёт. null — игрок уже вошёл. */
	public @Nullable Vec3 frozenPosition(ServerPlayer player) {
		Pending state = pending.get(player.getUUID());
		return state == null ? null : state.position;
	}

	public void teleportBack(ServerPlayer player) {
		Pending state = pending.get(player.getUUID());
		if (state != null) {
			player.connection.teleport(state.position.x, state.position.y, state.position.z, state.yRot, state.xRot);
		}
	}

	private void remind(ServerPlayer player, boolean registered) {
		player.sendSystemMessage(Component.literal(registered
				? "Этот ник защищён паролем. Введите: /login <пароль>"
				: "Первый вход на сервер. Придумайте пароль и введите его дважды: /register <пароль> <пароль>")
			.withStyle(ChatFormatting.GOLD));
	}

	private void authenticate(ServerPlayer player, Component message) {
		authenticated.add(player.getUUID());
		pending.remove(player.getUUID());
		player.connection.send(new ClientboundClearTitlesPacket(true));
		player.connection.send(new ClientboundSetActionBarTextPacket(Component.empty()));
		player.sendSystemMessage(message.copy().withStyle(ChatFormatting.GREEN));
		// До входа у игрока не было прав и команд — теперь выдаём настоящие.
		server.getPlayerList().sendPlayerPermissionLevel(player);
		server.getCommands().sendCommands(player);
	}

	// ---------- команды игрока ----------

	public void register(ServerPlayer player, String password, String repeat) {
		if (isAuthenticated(player)) {
			player.sendSystemMessage(Component.literal("Вы уже вошли.").withStyle(ChatFormatting.YELLOW));
			return;
		}
		String name = player.getGameProfile().name();
		AuthStore.Account account = store.get(name);
		if (account != null && account.passwordHash != null) {
			fail(player, "Этот ник уже зарегистрирован. Войдите: /login <пароль>");
			return;
		}
		String problem = passwordProblem(name, password, repeat);
		if (problem != null) {
			fail(player, problem);
			return;
		}
		Pending state = pending.get(player.getUUID());
		if (state == null || state.checking) {
			return;
		}
		state.checking = true;
		UUID id = player.getUUID();
		CompletableFuture.supplyAsync(() -> Passwords.hash(password), hashing).whenCompleteAsync((hash, error) -> {
			state.checking = false;
			ServerPlayer online = server.getPlayerList().getPlayer(id);
			if (online == null || !pending.containsKey(id)) {
				return;
			}
			if (error != null) {
				LOGGER.error("Не удалось сохранить пароль для {}", name, error);
				fail(online, "Не получилось сохранить пароль, попробуйте ещё раз.");
				return;
			}
			store.update(name, acc -> {
				acc.name = name;
				acc.passwordHash = hash;
				acc.registeredAt = System.currentTimeMillis();
				acc.lastLoginAt = acc.registeredAt;
				return acc;
			});
			LOGGER.info("{} зарегистрировался", name);
			authenticate(online, Component.literal("Пароль сохранён, вы вошли. В следующий раз: /login <пароль>"));
		}, server);
	}

	public void login(ServerPlayer player, String password) {
		if (isAuthenticated(player)) {
			player.sendSystemMessage(Component.literal("Вы уже вошли.").withStyle(ChatFormatting.YELLOW));
			return;
		}
		String name = player.getGameProfile().name();
		AuthStore.Account account = store.get(name);
		if (account == null || account.passwordHash == null) {
			fail(player, "У этого ника ещё нет пароля. Придумайте его: /register <пароль> <пароль>");
			return;
		}
		Pending state = pending.get(player.getUUID());
		if (state == null || state.checking) {
			return;
		}
		state.checking = true;
		UUID id = player.getUUID();
		String ip = player.getIpAddress();
		String hash = account.passwordHash;
		CompletableFuture.supplyAsync(() -> Passwords.verify(password, hash), hashing).whenCompleteAsync((ok, error) -> {
			state.checking = false;
			ServerPlayer online = server.getPlayerList().getPlayer(id);
			if (online == null || !pending.containsKey(id)) {
				return;
			}
			if (error == null && ok) {
				store.update(name, acc -> {
					acc.lastLoginAt = System.currentTimeMillis();
					return acc;
				});
				authenticate(online, Component.literal("Вы вошли. Приятной игры!"));
				return;
			}
			state.attempts++;
			int left = config.maxLoginAttempts - state.attempts;
			LOGGER.info("Неверный пароль для {} (попытка {})", name, state.attempts);
			if (left <= 0) {
				pending.remove(id);
				if (config.lockoutSeconds > 0) {
					lockouts.put(ip, System.currentTimeMillis() + config.lockoutSeconds * 1000L);
				}
				online.connection.disconnect(Component.literal("Неверный пароль. Попробуйте снова через " + config.lockoutSeconds + " сек."));
			} else {
				fail(online, "Неверный пароль. Осталось попыток: " + left + ".");
			}
		}, server);
	}

	public void changePassword(ServerPlayer player, String oldPassword, String newPassword) {
		String name = player.getGameProfile().name();
		AuthStore.Account account = store.get(name);
		if (!isAuthenticated(player)) {
			fail(player, "Сначала войдите: /login <пароль>");
			return;
		}
		if (account == null || account.passwordHash == null) {
			fail(player, Boolean.TRUE.equals(account == null ? null : account.premium)
				? "Вы входите по лицензии — пароль не нужен."
				: "У вас ещё нет пароля.");
			return;
		}
		String problem = passwordProblem(name, newPassword, newPassword);
		if (problem != null) {
			fail(player, problem);
			return;
		}
		UUID id = player.getUUID();
		String hash = account.passwordHash;
		CompletableFuture.supplyAsync(() -> Passwords.verify(oldPassword, hash) ? Passwords.hash(newPassword) : null, hashing)
			.whenCompleteAsync((newHash, error) -> {
				ServerPlayer online = server.getPlayerList().getPlayer(id);
				if (online == null) {
					return;
				}
				if (error != null || newHash == null) {
					fail(online, "Старый пароль неверный.");
					return;
				}
				store.update(name, acc -> {
					acc.passwordHash = newHash;
					return acc;
				});
				sessions.remove(AuthStore.key(name));
				online.sendSystemMessage(Component.literal("Пароль изменён.").withStyle(ChatFormatting.GREEN));
			}, server);
	}

	private @Nullable String passwordProblem(String name, String password, String repeat) {
		if (!password.equals(repeat)) {
			return "Пароли не совпадают. Введите один и тот же пароль два раза.";
		}
		if (password.length() < config.minPasswordLength) {
			return "Слишком короткий пароль: нужно хотя бы " + config.minPasswordLength + " символов.";
		}
		if (password.length() > 64) {
			return "Слишком длинный пароль (больше 64 символов).";
		}
		if (password.equalsIgnoreCase(name) || WEAK_PASSWORDS.contains(password.toLowerCase(Locale.ROOT))) {
			return "Этот пароль слишком простой — его подберут за секунду. Придумайте другой.";
		}
		return null;
	}

	private static void fail(ServerPlayer player, String message) {
		player.sendSystemMessage(Component.literal(message).withStyle(ChatFormatting.RED));
	}

	// ---------- администрирование ----------

	/** Сбросить пароль: игрок заново придумает его через /register. */
	public boolean resetPassword(String name) {
		if (store.get(name) == null) {
			return false;
		}
		store.update(name, acc -> {
			acc.passwordHash = null;
			return acc;
		});
		sessions.remove(AuthStore.key(name));
		kickIfOnline(name, "Администратор сбросил ваш пароль. Зайдите снова и придумайте новый.");
		return true;
	}

	/** true — только лицензия, false — только пароль, null — автоматически. */
	public void setMode(String name, @Nullable Boolean premium) {
		store.update(name, acc -> {
			acc.name = acc.name == null ? name : acc.name;
			acc.premium = premium;
			if (Boolean.TRUE.equals(premium)) {
				acc.passwordHash = null;
			}
			return acc;
		});
		sessions.remove(AuthStore.key(name));
	}

	public boolean unregister(String name) {
		sessions.remove(AuthStore.key(name));
		boolean removed = store.remove(name);
		kickIfOnline(name, "Ваш аккаунт удалён администратором.");
		return removed;
	}

	private void kickIfOnline(String name, String reason) {
		ServerPlayer online = server.getPlayerList().getPlayer(name);
		if (online != null) {
			online.connection.disconnect(Component.literal(reason));
		}
	}
}
