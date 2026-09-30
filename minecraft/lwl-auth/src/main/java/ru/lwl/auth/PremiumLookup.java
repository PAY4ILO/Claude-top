package ru.lwl.auth;

import java.net.ProxySelector;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.Locale;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.Executor;
import java.util.function.IntSupplier;
import java.util.regex.Pattern;

/** Спрашивает у Mojang, есть ли лицензионный аккаунт с таким ником. */
public final class PremiumLookup {
	private static final Pattern NICKNAME = Pattern.compile("[A-Za-z0-9_]{1,16}");

	private final HttpClient http;
	private final IntSupplier timeoutSeconds;

	public PremiumLookup(Executor executor, IntSupplier timeoutSeconds) {
		this.timeoutSeconds = timeoutSeconds;
		HttpClient.Builder builder = HttpClient.newBuilder()
			.executor(executor)
			.connectTimeout(Duration.ofSeconds(5));
		ProxySelector proxy = ProxySelector.getDefault();
		if (proxy != null) {
			builder.proxy(proxy);
		}
		this.http = builder.build();
	}

	/** Ник, который в принципе может быть у лицензии. Остальные сразу считаются пиратскими. */
	public static boolean couldBePremium(String name) {
		return NICKNAME.matcher(name).matches();
	}

	/** true — лицензия с таким ником есть, false — нет. Ошибка — Mojang не ответил. */
	public CompletableFuture<Boolean> exists(String name) {
		String nick = name.toLowerCase(Locale.ROOT);
		return get("https://api.mojang.com/users/profiles/minecraft/" + nick)
			.thenCompose(status -> status >= 500 || status == 403 || status == 429
				? get("https://api.minecraftservices.com/minecraft/profile/lookup/name/" + nick)
				: CompletableFuture.completedFuture(status))
			.thenApply(status -> switch (status) {
				case 200 -> true;
				case 204, 404 -> false;
				default -> throw new IllegalStateException("Mojang ответил " + status);
			});
	}

	private CompletableFuture<Integer> get(String url) {
		HttpRequest request = HttpRequest.newBuilder(URI.create(url))
			.timeout(Duration.ofSeconds(timeoutSeconds.getAsInt()))
			.header("User-Agent", "LWL-Auth/1.0 (Fabric server mod)")
			.GET()
			.build();
		return http.sendAsync(request, HttpResponse.BodyHandlers.discarding()).thenApply(HttpResponse::statusCode);
	}
}
