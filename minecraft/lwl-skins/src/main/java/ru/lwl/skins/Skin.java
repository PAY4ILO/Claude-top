package ru.lwl.skins;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.mojang.authlib.properties.Property;

import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.Objects;

/**
 * Текстуры игрока в том виде, в каком их отдаёт Mojang: base64-JSON и подпись.
 * Клиент рисует скин только если подпись настоящая, поэтому здесь нет способа
 * «собрать» скин самому — только взять готовый у Mojang или MineSkin.
 */
public record Skin(String value, String signature) {
	public static final String PROPERTY = "textures";

	public Skin {
		Objects.requireNonNull(value, "value");
		Objects.requireNonNull(signature, "signature");
	}

	public Property toProperty() {
		return new Property(PROPERTY, value, signature);
	}

	/** Ссылка на картинку скина (textures.minecraft.net) или null, если её нет. */
	public String textureUrl() {
		try {
			JsonObject skin = decode().getAsJsonObject("textures").getAsJsonObject("SKIN");
			return skin == null ? null : skin.get("url").getAsString();
		} catch (RuntimeException e) {
			return null;
		}
	}

	public boolean isSlim() {
		try {
			JsonObject skin = decode().getAsJsonObject("textures").getAsJsonObject("SKIN");
			JsonObject meta = skin == null ? null : skin.getAsJsonObject("metadata");
			return meta != null && "slim".equals(meta.get("model").getAsString());
		} catch (RuntimeException e) {
			return false;
		}
	}

	private JsonObject decode() {
		String json = new String(Base64.getDecoder().decode(value), StandardCharsets.UTF_8);
		return JsonParser.parseString(json).getAsJsonObject();
	}
}
