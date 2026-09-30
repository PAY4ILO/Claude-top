package ru.lwl.auth;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonParseException;
import com.google.gson.reflect.TypeToken;
import org.jspecify.annotations.Nullable;
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
import java.util.function.UnaryOperator;

/**
 * Аккаунты на диске сервера: config/lwl-auth/accounts.json (ник → хеш пароля и режим)
 * и premium-cache.json (есть ли у ника лицензия). IP и пароли в открытом виде не хранятся.
 */
public final class AuthStore {
	private static final Logger LOGGER = LoggerFactory.getLogger("LWL Auth");
	private static final Gson GSON = new GsonBuilder().setPrettyPrinting().disableHtmlEscaping().create();
	private static final Type ACCOUNTS_TYPE = new TypeToken<TreeMap<String, Account>>() {}.getType();
	private static final Type CACHE_TYPE = new TypeToken<TreeMap<String, PremiumCheck>>() {}.getType();

	public static final class Account {
		public String name;
		/** null — пароль ещё не придуман. */
		public @Nullable String passwordHash;
		/**
		 * true — ник закреплён за лицензией (вход только с неё, без пароля);
		 * false — вход только по паролю, даже если такой ник есть у Mojang;
		 * null — решает мод (лицензия, если Mojang знает ник и пароль не заведён).
		 */
		public @Nullable Boolean premium;
		public long registeredAt;
		public long lastLoginAt;

		public Account() {
		}

		Account(String name) {
			this.name = name;
		}

		public Account copy() {
			Account copy = new Account(name);
			copy.passwordHash = passwordHash;
			copy.premium = premium;
			copy.registeredAt = registeredAt;
			copy.lastLoginAt = lastLoginAt;
			return copy;
		}
	}

	/** Результат проверки ника у Mojang. */
	public static final class PremiumCheck {
		public boolean premium;
		public long checkedAt;

		public PremiumCheck() {
		}

		PremiumCheck(boolean premium) {
			this.premium = premium;
			this.checkedAt = System.currentTimeMillis();
		}
	}

	private final Path accountsFile;
	private final Path cacheFile;
	private final Executor io;
	private final Map<String, Account> accounts = new ConcurrentHashMap<>();
	private final Map<String, PremiumCheck> premiumCache = new ConcurrentHashMap<>();
	private final AtomicBoolean accountsDirty = new AtomicBoolean();
	private final AtomicBoolean cacheDirty = new AtomicBoolean();

	public AuthStore(Path dir, Executor io) {
		this.accountsFile = dir.resolve("accounts.json");
		this.cacheFile = dir.resolve("premium-cache.json");
		this.io = io;
		try {
			Files.createDirectories(dir);
		} catch (IOException e) {
			LOGGER.error("Не удалось создать папку {}: {}", dir, e.getMessage());
		}
		Map<String, Account> loaded = read(accountsFile, ACCOUNTS_TYPE, true);
		loaded.forEach((key, account) -> {
			if (account != null && account.name != null) {
				accounts.put(key(account.name), account);
			}
		});
		Map<String, PremiumCheck> cache = read(cacheFile, CACHE_TYPE, false);
		cache.forEach((key, check) -> {
			if (check != null) {
				premiumCache.put(key(key), check);
			}
		});
		LOGGER.info("Аккаунтов: {}", accounts.size());
	}

	public static String key(String name) {
		return name.toLowerCase(Locale.ROOT);
	}

	/** Копия аккаунта (менять только через update). */
	public @Nullable Account get(String name) {
		Account account = accounts.get(key(name));
		return account == null ? null : account.copy();
	}

	/** Меняет аккаунт (создаёт, если его нет) и сохраняет файл. */
	public Account update(String name, UnaryOperator<Account> change) {
		Account result = accounts.compute(key(name), (k, old) -> {
			Account copy = old == null ? new Account(name) : old.copy();
			return change.apply(copy);
		});
		saveAccountsLater();
		return result.copy();
	}

	public boolean remove(String name) {
		boolean removed = accounts.remove(key(name)) != null;
		if (removed) {
			saveAccountsLater();
		}
		return removed;
	}

	public @Nullable PremiumCheck premiumCheck(String name) {
		return premiumCache.get(key(name));
	}

	public void cachePremium(String name, boolean premium) {
		premiumCache.put(key(name), new PremiumCheck(premium));
		cacheDirty.set(true);
		io.execute(this::flushCache);
	}

	private void saveAccountsLater() {
		accountsDirty.set(true);
		io.execute(this::flushAccounts);
	}

	public void flush() {
		flushAccounts();
		flushCache();
	}

	private synchronized void flushAccounts() {
		if (accountsDirty.getAndSet(false)) {
			write(accountsFile, new TreeMap<>(accounts));
		}
	}

	private synchronized void flushCache() {
		if (cacheDirty.getAndSet(false)) {
			write(cacheFile, new TreeMap<>(premiumCache));
		}
	}

	private static <T> Map<String, T> read(Path file, Type type, boolean critical) {
		if (!Files.exists(file)) {
			return Map.of();
		}
		try {
			Map<String, T> map = GSON.fromJson(Files.readString(file, StandardCharsets.UTF_8), type);
			return map == null ? Map.of() : map;
		} catch (IOException | JsonParseException e) {
			if (!critical) {
				LOGGER.warn("Файл {} повреждён ({}), начинаю с пустого", file, e.getMessage());
				return Map.of();
			}
			// Аккаунты — не то, что можно молча обнулить: без них любой займёт чужой ник.
			throw new IllegalStateException("Файл " + file + " повреждён: " + e.getMessage()
				+ ". Восстановите его из резервной копии (accounts.json.bak) или удалите вручную.", e);
		}
	}

	private static void write(Path file, Object data) {
		Path tmp = file.resolveSibling(file.getFileName() + ".tmp");
		try {
			Files.writeString(tmp, GSON.toJson(data), StandardCharsets.UTF_8);
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
