package ru.lwl.skins.client;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.mojang.authlib.SignatureState;
import com.mojang.authlib.minecraft.MinecraftProfileTexture;
import com.mojang.authlib.minecraft.MinecraftProfileTextures;
import com.mojang.authlib.properties.Property;
import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.regex.Pattern;
import org.jspecify.annotations.Nullable;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Клиентская часть LWL Skins: чтобы на пиратке были видны скины других игроков.
 *
 * Клиент Minecraft показывает чужой скин, только если проверил подпись Mojang на нём. Пиратские лаунчеры
 * (TLauncher, лаунчеры с Ely.by через authlib-injector и т. п.) подменяют authlib или ключи Mojang —
 * проверка не проходит, и все вокруг выглядят Стивом/Алекс (в логе: «Profile contained invalid signature
 * for textures property»). Если сервисы Mojang недоступны, клиент не знает даже, с каких адресов можно
 * грузить скины, и не показывает никого.
 *
 * Мы доверяем текстурам, которые лежат на textures.minecraft.net, даже без проверенной подписи. Это
 * безопасно: туда попадают только картинки, загруженные в Mojang, а подписанный скин любой такой картинки
 * сервер и так может прислать (MineSkin). Чужие адреса по-прежнему не принимаются.
 */
public final class TrustedTextures {
	private static final Logger LOGGER = LoggerFactory.getLogger("LWL Skins");
	private static final Pattern MOJANG_TEXTURE = Pattern.compile("^https?://textures\\.minecraft\\.net/texture/[0-9a-fA-F]{1,128}$");
	private static final AtomicBoolean NOTICED = new AtomicBoolean();

	private TrustedTextures() {
	}

	/**
	 * Вместо результата обычной проверки: если подпись не подтвердилась (или проверка упала, потому что
	 * сервисы Mojang недоступны), а все текстуры — с textures.minecraft.net, возвращаем их как проверенные.
	 */
	public static MinecraftProfileTextures unpack(Property property, @Nullable MinecraftProfileTextures checked) {
		if (checked != null && checked.signatureState() == SignatureState.SIGNED) {
			return checked;
		}
		MinecraftProfileTextures trusted = fromMojangCdn(property);
		if (trusted == null) {
			return checked != null ? checked : MinecraftProfileTextures.EMPTY;
		}
		if (NOTICED.compareAndSet(false, true)) {
			LOGGER.info("Подпись скинов не проверить (пиратский лаунчер или нет связи с Mojang) — показываю скины с textures.minecraft.net");
		}
		return trusted;
	}

	/** Текстуры из свойства «textures», если все они с textures.minecraft.net; иначе null. */
	static @Nullable MinecraftProfileTextures fromMojangCdn(Property property) {
		try {
			String json = new String(Base64.getDecoder().decode(property.value()), StandardCharsets.UTF_8);
			JsonObject textures = JsonParser.parseString(json).getAsJsonObject().getAsJsonObject("textures");
			if (textures == null || textures.isEmpty()) {
				return null;
			}
			Map<String, MinecraftProfileTexture> byType = new HashMap<>();
			for (Map.Entry<String, JsonElement> entry : textures.entrySet()) {
				JsonObject texture = entry.getValue().getAsJsonObject();
				String url = texture.get("url").getAsString();
				if (!MOJANG_TEXTURE.matcher(url).matches()) {
					return null;
				}
				Map<String, String> metadata = new HashMap<>();
				JsonObject meta = texture.getAsJsonObject("metadata");
				if (meta != null) {
					for (Map.Entry<String, JsonElement> m : meta.entrySet()) {
						metadata.put(m.getKey(), m.getValue().getAsString());
					}
				}
				byType.put(entry.getKey(), new MinecraftProfileTexture(url, metadata));
			}
			MinecraftProfileTexture skin = byType.get("SKIN");
			MinecraftProfileTexture cape = byType.get("CAPE");
			MinecraftProfileTexture elytra = byType.get("ELYTRA");
			if (skin == null && cape == null && elytra == null) {
				return null;
			}
			return new MinecraftProfileTextures(skin, cape, elytra, SignatureState.SIGNED);
		} catch (RuntimeException e) {
			return null; // не base64/JSON или нет url — пусть решает обычная проверка
		}
	}
}
