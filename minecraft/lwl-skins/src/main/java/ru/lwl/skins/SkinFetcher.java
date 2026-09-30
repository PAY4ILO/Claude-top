package ru.lwl.skins;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.net.ProxySelector;
import java.net.URI;
import java.net.URISyntaxException;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.Locale;
import java.util.Optional;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.Executor;
import java.util.function.Supplier;
import java.util.regex.Pattern;

/**
 * Сетевые запросы: скин лицензионного аккаунта (Mojang) и скин по ссылке (MineSkin).
 * MineSkin загружает картинку на свой лицензионный аккаунт и возвращает подписанные
 * Mojang текстуры — только такие клиент согласится показать.
 */
public final class SkinFetcher {
	private static final Logger LOGGER = LoggerFactory.getLogger("LWL Skins");
	private static final Pattern NICKNAME = Pattern.compile("[A-Za-z0-9_]{1,16}");
	private static final String USER_AGENT = "LWL-Skins/1.0 (Fabric server mod)";

	private final HttpClient http;
	private final Supplier<SkinConfig> config;

	public SkinFetcher(Executor executor, Supplier<SkinConfig> config) {
		this.config = config;
		HttpClient.Builder builder = HttpClient.newBuilder()
			.executor(executor)
			.connectTimeout(Duration.ofSeconds(10))
			.followRedirects(HttpClient.Redirect.NORMAL);
		ProxySelector proxy = ProxySelector.getDefault();
		if (proxy != null) {
			builder.proxy(proxy);
		}
		this.http = builder.build();
	}

	public static boolean isValidNickname(String nick) {
		return nick != null && NICKNAME.matcher(nick).matches();
	}

	/** Скин лицензионного аккаунта с таким ником. Пусто — такого аккаунта нет. */
	public CompletableFuture<Optional<Skin>> premiumSkin(String nick) {
		if (!isValidNickname(nick)) {
			return CompletableFuture.failedFuture(new SkinException("Ник «" + nick + "» не может принадлежать лицензии: только латиница, цифры и _, до 16 символов."));
		}
		return lookupUuid(nick).thenCompose(uuid -> uuid.isEmpty()
			? CompletableFuture.completedFuture(Optional.<Skin>empty())
			: profileTextures(uuid.get()));
	}

	private CompletableFuture<Optional<String>> lookupUuid(String nick) {
		String name = nick.toLowerCase(Locale.ROOT);
		return get("https://api.mojang.com/users/profiles/minecraft/" + name)
			.thenCompose(res -> {
				// Старый адрес иногда отвечает 403/5xx — тогда спрашиваем новый.
				if (res.statusCode() >= 500 || res.statusCode() == 403) {
					return get("https://api.minecraftservices.com/minecraft/profile/lookup/name/" + name);
				}
				return CompletableFuture.completedFuture(res);
			})
			.thenApply(res -> switch (res.statusCode()) {
				case 200 -> Optional.of(json(res).get("id").getAsString());
				case 204, 404 -> Optional.<String>empty();
				case 429 -> throw new SkinException("Mojang просит подождать: слишком много запросов. Попробуйте через минуту.");
				default -> throw new SkinException("Mojang не отвечает (код " + res.statusCode() + "). Попробуйте позже.");
			});
	}

	private CompletableFuture<Optional<Skin>> profileTextures(String uuid) {
		return get("https://sessionserver.mojang.com/session/minecraft/profile/" + uuid + "?unsigned=false")
			.thenApply(res -> {
				if (res.statusCode() == 204 || res.statusCode() == 404) {
					return Optional.<Skin>empty();
				}
				if (res.statusCode() == 429) {
					throw new SkinException("Mojang просит подождать: слишком много запросов. Попробуйте через минуту.");
				}
				if (res.statusCode() != 200) {
					throw new SkinException("Сервер скинов Mojang не отвечает (код " + res.statusCode() + ").");
				}
				JsonArray props = json(res).getAsJsonArray("properties");
				if (props != null) {
					for (JsonElement el : props) {
						JsonObject p = el.getAsJsonObject();
						if (Skin.PROPERTY.equals(p.get("name").getAsString()) && p.has("signature")) {
							return Optional.of(new Skin(p.get("value").getAsString(), p.get("signature").getAsString()));
						}
					}
				}
				return Optional.<Skin>empty();
			});
	}

	/** Проверяет ссылку и возвращает её в нормальном виде или бросает SkinException. */
	public static URI checkUrl(String raw) {
		URI uri;
		try {
			uri = new URI(raw.trim());
		} catch (URISyntaxException e) {
			throw new SkinException("Это не похоже на ссылку. Пример: https://example.com/skin.png");
		}
		String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase(Locale.ROOT);
		if (!scheme.equals("http") && !scheme.equals("https") || uri.getHost() == null) {
			throw new SkinException("Нужна прямая ссылка на картинку, начинающаяся с https://");
		}
		if (raw.length() > 1000) {
			throw new SkinException("Слишком длинная ссылка.");
		}
		return uri;
	}

	/** Скин из PNG по ссылке через MineSkin. */
	public CompletableFuture<Skin> skinFromUrl(String url, boolean slim) {
		URI uri;
		try {
			uri = checkUrl(url);
		} catch (SkinException e) {
			return CompletableFuture.failedFuture(e);
		}
		JsonObject body = new JsonObject();
		body.addProperty("url", uri.toString());
		body.addProperty("variant", slim ? "slim" : "classic");
		body.addProperty("visibility", "unlisted");
		HttpRequest.Builder req = request("https://api.mineskin.org/v2/generate")
			.header("Content-Type", "application/json")
			.POST(HttpRequest.BodyPublishers.ofString(body.toString(), StandardCharsets.UTF_8));
		String key = config.get().mineskinApiKey;
		if (!key.isEmpty()) {
			req.header("Authorization", "Bearer " + key);
		}
		return send(req.build()).thenApply(res -> {
			JsonObject json;
			try {
				json = json(res);
			} catch (RuntimeException e) {
				throw new SkinException("MineSkin ответил непонятно (код " + res.statusCode() + "). Попробуйте позже.");
			}
			if (res.statusCode() == 429) {
				throw new SkinException("MineSkin: слишком много скинов подряд. Подождите минуту и повторите.");
			}
			if (res.statusCode() != 200 || !json.has("skin")) {
				throw new SkinException("MineSkin не смог сделать скин: " + mineskinError(json, res.statusCode()));
			}
			JsonObject data = json.getAsJsonObject("skin").getAsJsonObject("texture").getAsJsonObject("data");
			return new Skin(data.get("value").getAsString(), data.get("signature").getAsString());
		});
	}

	private static String mineskinError(JsonObject json, int status) {
		JsonArray errors = json.getAsJsonArray("errors");
		if (errors != null && !errors.isEmpty()) {
			JsonObject first = errors.get(0).getAsJsonObject();
			String code = first.has("code") ? first.get("code").getAsString() : "";
			String message = first.has("message") ? first.get("message").getAsString() : code;
			return switch (code) {
				case "invalid_image", "invalid_image_dimensions", "invalid_image_format" ->
					"по ссылке не скин. Нужен PNG 64×64 (или 64×32).";
				case "failed_to_download", "invalid_url", "url_not_accessible" ->
					"не получилось скачать картинку. Ссылка должна вести прямо на .png и открываться без входа.";
				case "invalid_api_key" -> "неверный mineskinApiKey в config/lwl-skins.json.";
				default -> message;
			};
		}
		return "код " + status;
	}

	private CompletableFuture<HttpResponse<String>> get(String url) {
		return send(request(url).GET().build());
	}

	private HttpRequest.Builder request(String url) {
		return HttpRequest.newBuilder(URI.create(url))
			.timeout(Duration.ofSeconds(config.get().requestTimeoutSeconds))
			.header("User-Agent", USER_AGENT)
			.header("Accept", "application/json");
	}

	private CompletableFuture<HttpResponse<String>> send(HttpRequest request) {
		return http.sendAsync(request, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8))
			.exceptionally(error -> {
				LOGGER.warn("Запрос {} не удался: {}", request.uri().getHost(), error.toString());
				throw new SkinException("Нет связи с " + request.uri().getHost() + ". Попробуйте позже.", error);
			});
	}

	private static JsonObject json(HttpResponse<String> res) {
		return JsonParser.parseString(res.body()).getAsJsonObject();
	}
}
