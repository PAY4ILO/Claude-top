package ru.lwl.skins;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonParseException;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

/** Настройки из config/lwl-skins.json. Недостающие поля берутся по умолчанию. */
public final class SkinConfig {
	private static final Logger LOGGER = LoggerFactory.getLogger("LWL Skins");
	private static final Gson GSON = new GsonBuilder().setPrettyPrinting().disableHtmlEscaping().create();

	/** Если своего скина нет — взять скин лицензионного аккаунта с таким же ником. */
	public boolean skinFromNickname = true;
	/** Сколько ждать скин при входе, прежде чем пустить игрока без него (скин догрузится сам). */
	public int loginWaitMillis = 3000;
	/** Сколько часов помнить скин лицензионного ника (и то, что такого ника нет). */
	public int nicknameCacheHours = 24;
	/** Пауза между командами /skin для обычных игроков. */
	public int commandCooldownSeconds = 30;
	/** Разрешить игрокам менять себе скин. false — менять может только администратор. */
	public boolean allowPlayersToChangeSkin = true;
	/** Ключ MineSkin (необязательно): без него лимит ~10 скинов по ссылке в минуту. */
	public String mineskinApiKey = "";
	/** Тайм-аут одного запроса к Mojang/MineSkin. */
	public int requestTimeoutSeconds = 15;

	public static SkinConfig load(Path file) {
		SkinConfig config = new SkinConfig();
		if (Files.exists(file)) {
			try {
				SkinConfig loaded = GSON.fromJson(Files.readString(file, StandardCharsets.UTF_8), SkinConfig.class);
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
		loginWaitMillis = Math.clamp(loginWaitMillis, 0, 20_000);
		nicknameCacheHours = Math.clamp(nicknameCacheHours, 0, 24 * 30);
		commandCooldownSeconds = Math.clamp(commandCooldownSeconds, 0, 3600);
		requestTimeoutSeconds = Math.clamp(requestTimeoutSeconds, 3, 120);
		if (mineskinApiKey == null) {
			mineskinApiKey = "";
		}
		mineskinApiKey = mineskinApiKey.trim();
	}
}
