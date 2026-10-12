package ru.lwl.stats;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;

/**
 * Запросы к сайту. Всё уходит в один свой поток с короткой очередью: поток сервера Minecraft
 * никогда не ждёт сеть. Очередь переполнилась (сайт долго не отвечает) — выбрасываются самые старые
 * запросы: список «кто в игре» и статистика всё равно придут заново со следующей отправкой.
 */
final class SiteClient {
	private static final Logger LOGGER = LoggerFactory.getLogger("LWL Stats");
	private static final String USER_AGENT = "LWL-Stats/1.0 (Fabric server mod)";
	private static final long LOG_EVERY_MS = 60_000;

	private final StatsConfig config;
	private final HttpClient http;
	private final ThreadPoolExecutor worker;
	private long lastErrorLog;
	private boolean failing;

	SiteClient(StatsConfig config) {
		this.config = config;
		this.worker = new ThreadPoolExecutor(1, 1, 0, TimeUnit.MILLISECONDS, new ArrayBlockingQueue<>(32),
			Thread.ofPlatform().name("lwl-stats-net").daemon().factory(), new ThreadPoolExecutor.DiscardOldestPolicy());
		this.http = HttpClient.newBuilder()
			.connectTimeout(Duration.ofSeconds(config.requestTimeoutSeconds))
			.followRedirects(HttpClient.Redirect.NEVER)
			.build();
	}

	/** Поставить запрос в очередь. Возвращается сразу. */
	void post(String path, JsonObject body) {
		String json = body.toString();
		worker.execute(() -> send(path, json));
	}

	/** Остановка сервера: дождаться отправки того, что уже в очереди, но не дольше timeout. */
	void close(Duration timeout) {
		worker.shutdown();
		try {
			if (!worker.awaitTermination(timeout.toMillis(), TimeUnit.MILLISECONDS)) {
				worker.shutdownNow();
			}
		} catch (InterruptedException e) {
			worker.shutdownNow();
			Thread.currentThread().interrupt();
		}
	}

	private void send(String path, String json) {
		try {
			HttpRequest request = HttpRequest.newBuilder(URI.create(config.siteUrl + path))
				.timeout(Duration.ofSeconds(config.requestTimeoutSeconds))
				.header("Authorization", "Bearer " + config.siteToken)
				.header("Content-Type", "application/json")
				// Сайт принимает POST только с этим заголовком (защита от CSRF).
				.header("X-Requested-With", "lwl")
				.header("User-Agent", USER_AGENT)
				.POST(HttpRequest.BodyPublishers.ofString(json, StandardCharsets.UTF_8))
				.build();
			HttpResponse<String> res = http.send(request, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
			if (res.statusCode() / 100 == 2) {
				if (failing) {
					failing = false;
					LOGGER.info("Связь с сайтом восстановлена.");
				}
				return;
			}
			error(path + ": " + explain(res));
		} catch (InterruptedException e) {
			Thread.currentThread().interrupt();
		} catch (Exception e) {
			error(path + ": нет связи с " + config.siteUrl + " (" + e + ")");
		}
	}

	private static String explain(HttpResponse<String> res) {
		String message = "";
		try {
			JsonObject body = JsonParser.parseString(res.body()).getAsJsonObject();
			message = body.has("message") ? body.get("message").getAsString() : "";
		} catch (RuntimeException ignored) {
			// не JSON — например, страница ошибки прокси
		}
		return switch (res.statusCode()) {
			case 401 -> "сайт не принял токен: siteToken в config/lwl-stats.json должен совпадать с LWL_GAME_TOKEN на сайте.";
			case 503 -> "на сайте не задан LWL_GAME_TOKEN.";
			case 404 -> "на сайте нет карточек игроков — обновите сайт LWL.";
			default -> "ответ " + res.statusCode() + (message.isEmpty() ? "" : " — " + message);
		};
	}

	/** Ошибки — не чаще раза в минуту, чтобы не засыпать лог, пока сайт недоступен. */
	private void error(String message) {
		failing = true;
		long now = System.currentTimeMillis();
		if (now - lastErrorLog >= LOG_EVERY_MS) {
			lastErrorLog = now;
			LOGGER.warn("Не удалось отправить статистику на сайт: {}", message);
		}
	}
}
