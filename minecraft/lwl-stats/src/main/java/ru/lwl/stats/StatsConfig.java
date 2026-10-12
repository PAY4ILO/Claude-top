package ru.lwl.stats;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonParseException;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

/** Настройки из config/lwl-stats.json. Недостающие поля берутся по умолчанию. */
public final class StatsConfig {
	private static final Logger LOGGER = LoggerFactory.getLogger("LWL Stats");
	private static final Gson GSON = new GsonBuilder().setPrettyPrinting().disableHtmlEscaping().create();

	/** Адрес сайта, например https://lwl.example или http://127.0.0.1:8080, если сайт на той же машине. */
	public String siteUrl = "";
	/** Токен сервера: тот же, что LWL_GAME_TOKEN в /etc/lwl/lwl.env на машине сайта. */
	public String siteToken = "";
	/** Как часто напоминать сайту, кто в игре (секунд). Сайт считает игрока вышедшим через 150 с тишины. */
	public int heartbeatSeconds = 60;
	/** Как часто отправлять статистику тех, кто в игре (минут). При выходе игрока — сразу. */
	public int statsIntervalMinutes = 5;
	/** Тайм-аут одного запроса к сайту (секунд). */
	public int requestTimeoutSeconds = 10;
	/** false — мод ничего не отправляет. */
	public boolean enabled = true;

	public static StatsConfig load(Path file) {
		StatsConfig config = new StatsConfig();
		if (Files.exists(file)) {
			try {
				StatsConfig loaded = GSON.fromJson(Files.readString(file, StandardCharsets.UTF_8), StatsConfig.class);
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

	/** Можно ли отправлять: включено и заполнены адрес и токен. */
	public boolean ready() {
		return enabled && !siteUrl.isEmpty() && !siteToken.isEmpty();
	}

	private void clamp() {
		heartbeatSeconds = Math.clamp(heartbeatSeconds, 15, 120);
		statsIntervalMinutes = Math.clamp(statsIntervalMinutes, 1, 60);
		requestTimeoutSeconds = Math.clamp(requestTimeoutSeconds, 2, 60);
		siteUrl = siteUrl == null ? "" : siteUrl.trim().replaceAll("/+$", "");
		siteToken = siteToken == null ? "" : siteToken.trim();
	}
}
