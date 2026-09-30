package ru.lwl.skins;

import net.minecraft.network.protocol.game.ClientboundChangeDifficultyPacket;
import net.minecraft.network.protocol.game.ClientboundPlayerAbilitiesPacket;
import net.minecraft.network.protocol.game.ClientboundPlayerInfoRemovePacket;
import net.minecraft.network.protocol.game.ClientboundPlayerInfoUpdatePacket;
import net.minecraft.network.protocol.game.ClientboundRespawnPacket;
import net.minecraft.network.protocol.game.ClientboundSetExperiencePacket;
import net.minecraft.network.protocol.game.ClientboundSetPassengersPacket;
import net.minecraft.server.level.ServerEntity;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.server.network.ServerGamePacketListenerImpl;
import net.minecraft.server.network.ServerPlayerConnection;
import net.minecraft.server.players.PlayerList;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.level.storage.LevelData;
import ru.lwl.skins.mixin.ChunkMapAccessor;
import ru.lwl.skins.mixin.TrackedEntityAccessor;

import java.util.ArrayList;
import java.util.List;

/**
 * Показывает новый скин без перезахода.
 * Клиент запоминает скин игрока, пока видит его сущность, поэтому:
 * 1) всем пересылаем запись в списке игроков (там лежит профиль с текстурами);
 * 2) тем, кто видит игрока, заново «спавним» его сущность;
 * 3) самому игроку делаем тихий респаун в том же мире — иначе он не увидит
 *    свой скин в F5 и в инвентаре.
 */
public final class SkinRefresher {
	private SkinRefresher() {
	}

	public static void refresh(ServerPlayer player) {
		PlayerList players = player.level().getServer().getPlayerList();
		players.broadcastAll(new ClientboundPlayerInfoRemovePacket(List.of(player.getUUID())));
		players.broadcastAll(ClientboundPlayerInfoUpdatePacket.createPlayerInitializing(List.of(player)));
		respawnForViewers(player);
		respawnForSelf(player);
	}

	private static void respawnForViewers(ServerPlayer player) {
		Object tracked = ((ChunkMapAccessor) player.level().getChunkSource().chunkMap)
			.lwlSkins$getEntityMap().get(player.getId());
		if (tracked == null) {
			return;
		}
		TrackedEntityAccessor accessor = (TrackedEntityAccessor) tracked;
		ServerEntity serverEntity = accessor.lwlSkins$getServerEntity();
		for (ServerPlayerConnection connection : new ArrayList<>(accessor.lwlSkins$getSeenBy())) {
			ServerPlayer viewer = connection.getPlayer();
			if (viewer != player) {
				serverEntity.removePairing(viewer);
				serverEntity.addPairing(viewer);
			}
		}
	}

	private static void respawnForSelf(ServerPlayer player) {
		// Мёртвый или спящий игрок увидит скин после респауна/пробуждения —
		// трогать его сейчас значит сломать экран смерти или кровать.
		if (player.isDeadOrDying() || player.isSleeping() || player.isRemoved()) {
			return;
		}
		ServerGamePacketListenerImpl connection = player.connection;
		PlayerList players = player.level().getServer().getPlayerList();
		ServerLevel level = player.level();
		LevelData levelData = level.getLevelData();

		if (player.containerMenu != player.inventoryMenu) {
			player.closeContainer();
		}
		connection.send(new ClientboundRespawnPacket(player.createCommonSpawnInfo(level), ClientboundRespawnPacket.KEEP_ALL_DATA));
		connection.send(new ClientboundChangeDifficultyPacket(levelData.getDifficulty(), levelData.isDifficultyLocked()));
		players.sendPlayerPermissionLevel(player);
		connection.teleport(player.getX(), player.getY(), player.getZ(), player.getYRot(), player.getXRot());
		connection.send(new ClientboundPlayerAbilitiesPacket(player.getAbilities()));
		players.sendLevelInfo(player, level);
		players.sendAllPlayerInfo(player);
		players.sendActivePlayerEffects(player);
		player.sendPostEffects();
		connection.send(new ClientboundSetExperiencePacket(player.experienceProgress, player.totalExperience, player.experienceLevel));
		Entity vehicle = player.getVehicle();
		if (vehicle != null) {
			connection.send(new ClientboundSetPassengersPacket(vehicle));
		}
		if (!player.getPassengers().isEmpty()) {
			connection.send(new ClientboundSetPassengersPacket(player));
		}
	}
}
