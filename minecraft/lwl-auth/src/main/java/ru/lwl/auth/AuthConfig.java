package ru.lwl.auth;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonParseException;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

/** Настройки из config/lwl-auth.json. Недостающие поля берутся по умолчанию. */
public final class AuthConfig {
	private static final Logger LOGGER = LoggerFactory.getLogger("LWL Auth");
	private static final Gson GSON = new GsonBuilder().setPrettyPrinting().disableHtmlEscaping().create();

	/** Лицензия заходит без пароля: такой ник проверяется через сервер сессий Mojang. */
	public boolean premiumAutoLogin = true;
	/**
	 * Одинаковый (офлайн) UUID для всех. true — инвентари и приваты не слетят,
	 * если игрок сначала заходил с пиратки, а потом с лицензии, и наоборот.
	 */
	public boolean keepOfflineUuid = true;
	/** Шифровать соединение и для игроков без лицензии, чтобы пароль не шёл открытым текстом. */
	public boolean encryptOfflineConnections = true;
	/** Сколько секунд даётся на /login или /register. */
	public int loginTimeoutSeconds = 60;
	/** Сколько неверных паролей подряд — и кик. */
	public int maxLoginAttempts = 5;
	/** После кика за неверные пароли — пауза для этого IP, в секундах. */
	public int lockoutSeconds = 60;
	/** Если игрок перезашёл с того же IP в течение стольких минут, пароль не спрашивается. 0 — всегда спрашивать. */
	public int sessionMinutes = 10;
	/** Минимальная длина пароля. */
	public int minPasswordLength = 6;
	/** Сколько ждать ответ Mojang при проверке ника (секунд). */
	public int mojangTimeoutSeconds = 5;
	/** Сколько часов помнить, есть ли у ника лицензия. */
	public int premiumCacheHours = 24;
	/** Что видит игрок, которого нет во включённом вайтлисте (/wl on). */
	public String whitelistMessage = "Вас нет в вайтлисте сервера. Подайте заявку на сайте — после одобрения вас добавят.";

	public static AuthConfig load(Path file) {
		AuthConfig config = new AuthConfig();
		if (Files.exists(file)) {
			try {
				AuthConfig loaded = GSON.fromJson(Files.readString(file, StandardCharsets.UTF_8), AuthConfig.class);
				if (loaded != null) {
					config = loaded;
				}
			} catch (IOException | JsonParseException e) {
				LOGGER.error("Не читается {}, беру настройки по умолчанию: {}", file, e.getMessage());
				return config;
			}
		}
		config.clamp();
		try {
			Files.createDirectories(file.getParent());
			Files.writeString(file, GSON.toJson(config), StandardCharsets.UTF_8);
		} catch (IOException e) {
			LOGGER.warn("Не удалось записать {}: {}", file, e.getMessage());
		}
		return config;
	}

	private void clamp() {
		loginTimeoutSeconds = Math.clamp(loginTimeoutSeconds, 15, 600);
		maxLoginAttempts = Math.clamp(maxLoginAttempts, 1, 20);
		lockoutSeconds = Math.clamp(lockoutSeconds, 0, 3600);
		sessionMinutes = Math.clamp(sessionMinutes, 0, 24 * 60);
		minPasswordLength = Math.clamp(minPasswordLength, 4, 32);
		mojangTimeoutSeconds = Math.clamp(mojangTimeoutSeconds, 2, 20);
		premiumCacheHours = Math.clamp(premiumCacheHours, 0, 24 * 30);
		if (whitelistMessage == null || whitelistMessage.isBlank()) {
			whitelistMessage = new AuthConfig().whitelistMessage;
		}
	}
}
