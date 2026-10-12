package ru.lwl.stats;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerPlayer;
import org.jspecify.annotations.Nullable;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

/**
 * Когда и что отправлять. Все методы вызываются из потока сервера: здесь только собираются данные
 * (это быстро), а сама отправка уходит в SiteClient, в отдельный поток.
 *
 *   /api/game/presence — полный список тех, кто в игре: при входе и выходе игрока и раз в heartbeatSeconds;
 *   /api/game/stats    — статистика тех, кто в игре: раз в statsIntervalMinutes, и сразу — того, кто вышел.
 * При остановке сервера — последняя статистика и пустой список.
 */
public final class StatsManager {
	private static final Logger LOGGER = LoggerFactory.getLogger("LWL Stats");
	/** Столько игроков сайт принимает в одном запросе статистики. */
	private static final int STATS_BATCH = 50;
	private static volatile @Nullable StatsManager instance;

	private final MinecraftServer server;
	private final StatsConfig config;
	private final SiteClient client;
	private long nextPresence;
	private long nextStats;
	private boolean stopping;

	private StatsManager(MinecraftServer server, StatsConfig config) {
		this.server = server;
		this.config = config;
		this.client = new SiteClient(config);
		long now = System.currentTimeMillis();
		this.nextPresence = now;
		this.nextStats = now + Duration.ofMinutes(config.statsIntervalMinutes).toMillis();
	}

	public static void start(MinecraftServer server, Path configDir) {
		Path file = configDir.resolve("lwl-stats.json");
		StatsConfig config = StatsConfig.load(file);
		if (!config.enabled) {
			LOGGER.info("LWL Stats выключен (enabled: false в {}).", file);
			return;
		}
		if (!config.ready()) {
			LOGGER.info("LWL Stats ничего не отправляет: впишите в {} адрес сайта (siteUrl) и токен (siteToken — тот же, что LWL_GAME_TOKEN на сайте) и перезапустите сервер.", file);
			return;
		}
		instance = new StatsManager(server, config);
		LOGGER.info("LWL Stats: статистика игроков уходит на {}", config.siteUrl);
	}

	/** Сервер останавливается: последняя статистика, «все вышли», ждём отправку не дольше нескольких секунд. */
	public static void stop() {
		StatsManager manager = instance;
		instance = null;
		if (manager == null) {
			return;
		}
		manager.stopping = true;
		manager.sendStats(manager.server.getPlayerList().getPlayers());
		manager.client.post("/api/game/presence", presenceBody(List.of()));
		// Игра уже остановлена: подождать отправку можно, иначе она не успеет до выхода из Java.
		manager.client.close(Duration.ofSeconds(Math.min(5, manager.config.requestTimeoutSeconds)));
	}

	public static @Nullable StatsManager get() {
		return instance;
	}

	public void onJoin() {
		if (!stopping) {
			sendPresence(null);
		}
	}

	public void onLeave(ServerPlayer player) {
		if (stopping) {
			return;
		}
		// Игрок в момент события ещё может числиться в списке — исключаем его сами.
		sendPresence(player.getUUID());
		sendStats(List.of(player));
	}

	public void tick() {
		long now = System.currentTimeMillis();
		if (now >= nextPresence) {
			sendPresence(null);
		}
		if (now >= nextStats) {
			nextStats = now + Duration.ofMinutes(config.statsIntervalMinutes).toMillis();
			sendStats(server.getPlayerList().getPlayers());
		}
	}

	private void sendPresence(@Nullable UUID leaving) {
		nextPresence = System.currentTimeMillis() + Duration.ofSeconds(config.heartbeatSeconds).toMillis();
		List<ServerPlayer> online = new ArrayList<>();
		for (ServerPlayer player : server.getPlayerList().getPlayers()) {
			if (!player.getUUID().equals(leaving)) {
				online.add(player);
			}
		}
		client.post("/api/game/presence", presenceBody(online));
	}

	private static JsonObject presenceBody(List<ServerPlayer> online) {
		JsonArray players = new JsonArray();
		for (ServerPlayer player : online) {
			JsonObject p = new JsonObject();
			p.addProperty("nickname", player.getGameProfile().name());
			p.addProperty("uuid", player.getUUID().toString());
			players.add(p);
		}
		JsonObject body = new JsonObject();
		body.add("players", players);
		return body;
	}

	private void sendStats(List<ServerPlayer> players) {
		JsonArray batch = new JsonArray();
		for (ServerPlayer player : players) {
			try {
				batch.add(PlayerStats.collect(server, player));
			} catch (RuntimeException e) {
				LOGGER.warn("Не удалось собрать статистику {}: {}", player.getGameProfile().name(), e.toString());
			}
			if (batch.size() == STATS_BATCH) {
				postStats(batch);
				batch = new JsonArray();
			}
		}
		if (!batch.isEmpty()) {
			postStats(batch);
		}
	}

	private void postStats(JsonArray players) {
		JsonObject body = new JsonObject();
		body.add("players", players);
		client.post("/api/game/stats", body);
	}
}
