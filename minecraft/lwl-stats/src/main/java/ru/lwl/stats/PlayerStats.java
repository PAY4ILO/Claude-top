package ru.lwl.stats;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.mojang.authlib.properties.Property;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.PlayerAdvancements;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.stats.ServerStatsCounter;
import net.minecraft.stats.Stats;
import net.minecraft.world.level.block.Block;

import java.nio.charset.StandardCharsets;
import java.util.Base64;

/**
 * Статистика одного игрока в том виде, в каком её ждёт сайт (POST /api/game/stats).
 * Всё берётся из обычной статистики Minecraft (то же, что в меню «Статистика»), откуда именно — в README мода.
 * Никаких координат, инвентаря, IP и способа входа.
 */
final class PlayerStats {
	private static final int TICKS_PER_SECOND = 20;
	/** Падение тоже считается в сантиметрах, но это не «пройдено». */
	private static final String FALL = "fall_one_cm";

	private PlayerStats() {
	}

	static JsonObject collect(MinecraftServer server, ServerPlayer player) {
		ServerStatsCounter stats = player.getStats();
		JsonObject p = new JsonObject();
		p.addProperty("nickname", player.getGameProfile().name());
		p.addProperty("uuid", player.getUUID().toString());
		p.addProperty("playTimeSec", stats.getValue(Stats.CUSTOM.get(Stats.PLAY_TIME)) / TICKS_PER_SECOND);
		p.addProperty("deaths", stats.getValue(Stats.CUSTOM.get(Stats.DEATHS)));
		p.addProperty("mobKills", stats.getValue(Stats.CUSTOM.get(Stats.MOB_KILLS)));
		p.addProperty("playerKills", stats.getValue(Stats.CUSTOM.get(Stats.PLAYER_KILLS)));
		p.addProperty("blocksMined", blocksMined(stats));
		p.addProperty("distanceM", distanceCm(stats) / 100);
		p.addProperty("advancements", advancements(server, player.getAdvancements()));
		JsonObject skin = skin(player);
		if (skin != null) {
			p.add("skin", skin);
		}
		return p;
	}

	/** «Добыто блоков»: сумма minecraft:mined по всем блокам. */
	private static long blocksMined(ServerStatsCounter stats) {
		long total = 0;
		for (Block block : BuiltInRegistries.BLOCK) {
			total += stats.getValue(Stats.BLOCK_MINED, block);
		}
		return total;
	}

	/** «Пройдено»: все minecraft:custom вида *_one_cm (пешком, бегом, вплавь, на лодке, на элитрах…), кроме падения. */
	private static long distanceCm(ServerStatsCounter stats) {
		long total = 0;
		for (var id : BuiltInRegistries.CUSTOM_STAT) {
			String path = id.getPath();
			if (path.endsWith("_one_cm") && !path.equals(FALL)) {
				total += stats.getValue(Stats.CUSTOM.get(id));
			}
		}
		return total;
	}

	/** Сколько настоящих достижений получено: только те, что видны в меню (рецепты не считаются). */
	private static int advancements(MinecraftServer server, PlayerAdvancements progress) {
		int done = 0;
		for (var holder : server.getAdvancements().getAllAdvancements()) {
			if (holder.value().display().isPresent() && progress.getOrStartProgress(holder).isDone()) {
				done++;
			}
		}
		return done;
	}

	/**
	 * Скин — из свойства textures профиля игрока (его ставит Mojang, LWL Auth или LWL Skins):
	 * ссылка textures.minecraft.net и тонкие ли руки. Нет скина — null, сайт покажет скин по умолчанию.
	 */
	private static JsonObject skin(ServerPlayer player) {
		for (Property property : player.getGameProfile().properties().get("textures")) {
			try {
				String json = new String(Base64.getDecoder().decode(property.value()), StandardCharsets.UTF_8);
				JsonObject textures = JsonParser.parseString(json).getAsJsonObject().getAsJsonObject("textures");
				JsonObject skin = textures == null ? null : textures.getAsJsonObject("SKIN");
				if (skin == null || !skin.has("url")) {
					continue;
				}
				JsonObject meta = skin.getAsJsonObject("metadata");
				JsonObject out = new JsonObject();
				out.addProperty("url", skin.get("url").getAsString());
				out.addProperty("slim", meta != null && meta.has("model") && "slim".equals(meta.get("model").getAsString()));
				return out;
			} catch (RuntimeException ignored) {
				// испорченное свойство — как будто скина нет
			}
		}
		return null;
	}
}
