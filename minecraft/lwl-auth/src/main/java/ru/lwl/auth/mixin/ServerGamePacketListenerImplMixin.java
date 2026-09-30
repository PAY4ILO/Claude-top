package ru.lwl.auth.mixin;

import net.minecraft.ChatFormatting;
import net.minecraft.core.BlockPos;
import net.minecraft.network.chat.Component;
import net.minecraft.network.protocol.game.ClientboundBlockUpdatePacket;
import net.minecraft.network.protocol.game.ClientboundPlayerAbilitiesPacket;
import net.minecraft.network.protocol.game.ServerboundChatPacket;
import net.minecraft.network.protocol.game.ServerboundMovePlayerPacket;
import net.minecraft.network.protocol.game.ServerboundPlayerActionPacket;
import net.minecraft.network.protocol.game.ServerboundUseItemOnPacket;
import net.minecraft.network.protocol.game.ServerboundUseItemPacket;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.server.network.ServerGamePacketListenerImpl;
import net.minecraft.world.phys.BlockHitResult;
import net.minecraft.world.phys.Vec3;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.Shadow;
import org.spongepowered.asm.mixin.Unique;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;
import ru.lwl.auth.AuthManager;

/**
 * Пока игрок не ввёл пароль, он ничего не может: ни ходить, ни ломать, ни открывать
 * сундуки, ни писать в чат. Иначе любой зашёл бы под чужим ником и успел напакостить.
 */
@Mixin(ServerGamePacketListenerImpl.class)
public abstract class ServerGamePacketListenerImplMixin {
	@Shadow
	public ServerPlayer player;

	@Shadow
	public abstract void ackBlockChangesUpTo(int sequence);

	@Unique
	private boolean lwlAuth$locked() {
		AuthManager manager = AuthManager.get();
		return manager != null && !manager.isAuthenticated(player);
	}

	/** Для обработчиков, которые трогают мир: проверяем уже в потоке сервера. */
	@Unique
	private boolean lwlAuth$lockedOnServerThread() {
		return player.level().getServer().isSameThread() && lwlAuth$locked();
	}

	/** Просто выбрасываем пакет: ответ игроку не нужен. */
	@Inject(method = {
		"handleMoveVehicle", "handleInteract", "handleAttack", "handlePunch",
		"handlePickItemFromBlock", "handlePickItemFromEntity", "handleSignUpdate", "handleEditBook",
		"handleRenameItem", "handleSelectTrade", "handleSetBeaconPacket",
		"handleSetCommandBlock", "handleSetCommandMinecart", "handleSetStructureBlock", "handleSetJigsawBlock",
		"handleJigsawGenerate", "handleSetTestBlock", "handleTestInstanceBlockAction", "handleSetGameRule",
		"handleChangeDifficulty", "handleChangeGameMode", "handleLockDifficulty",
		"handleEntityTagQuery", "handleBlockEntityTagQuery", "handleTeleportToEntityPacket", "handleSpectatorAction",
		"handlePaddleBoat", "handlePlayerCommand", "handleDebugSubscriptionRequest",
		"handleContainerSlotStateChanged", "handleBundleItemSelectedPacket"
	}, at = @At("HEAD"), cancellable = true)
	private void lwlAuth$drop(CallbackInfo ci) {
		if (lwlAuth$locked()) {
			ci.cancel();
		}
	}

	/** Инвентарь: отменяем и возвращаем клиенту настоящее содержимое. */
	@Inject(method = {"handleContainerClick", "handleContainerButtonClick", "handlePlaceRecipe", "handleSetCreativeModeSlot"},
		at = @At("HEAD"), cancellable = true)
	private void lwlAuth$lockInventory(CallbackInfo ci) {
		if (lwlAuth$lockedOnServerThread()) {
			player.containerMenu.sendAllDataToRemote();
			ci.cancel();
		}
	}

	@Inject(method = "handlePlayerAbilities", at = @At("HEAD"), cancellable = true)
	private void lwlAuth$lockFlying(CallbackInfo ci) {
		if (lwlAuth$lockedOnServerThread()) {
			player.connection.send(new ClientboundPlayerAbilitiesPacket(player.getAbilities()));
			ci.cancel();
		}
	}

	/** Стоим на месте: если клиент сдвинулся — возвращаем. Повороты головы не мешают. */
	@Inject(method = "handleMovePlayer", at = @At("HEAD"), cancellable = true)
	private void lwlAuth$freeze(ServerboundMovePlayerPacket packet, CallbackInfo ci) {
		if (!lwlAuth$lockedOnServerThread()) {
			return;
		}
		AuthManager manager = AuthManager.get();
		Vec3 frozen = manager == null ? null : manager.frozenPosition(player);
		if (frozen != null && packet.hasPosition()
			&& frozen.distanceToSqr(packet.getX(frozen.x), packet.getY(frozen.y), packet.getZ(frozen.z)) > 0.0025) {
			manager.teleportBack(player);
		}
		ci.cancel();
	}

	@Inject(method = "handlePlayerAction", at = @At("HEAD"), cancellable = true)
	private void lwlAuth$lockAction(ServerboundPlayerActionPacket packet, CallbackInfo ci) {
		if (lwlAuth$lockedOnServerThread()) {
			ackBlockChangesUpTo(packet.getSequence());
			lwlAuth$resendBlock(packet.getPos());
			player.containerMenu.sendAllDataToRemote();
			ci.cancel();
		}
	}

	@Inject(method = "handleUseItemOn", at = @At("HEAD"), cancellable = true)
	private void lwlAuth$lockUseOn(ServerboundUseItemOnPacket packet, CallbackInfo ci) {
		if (lwlAuth$lockedOnServerThread()) {
			ackBlockChangesUpTo(packet.sequence());
			BlockHitResult hit = packet.hitResult();
			lwlAuth$resendBlock(hit.getBlockPos());
			lwlAuth$resendBlock(hit.getBlockPos().relative(hit.getDirection()));
			player.containerMenu.sendAllDataToRemote();
			ci.cancel();
		}
	}

	@Inject(method = "handleUseItem", at = @At("HEAD"), cancellable = true)
	private void lwlAuth$lockUse(ServerboundUseItemPacket packet, CallbackInfo ci) {
		if (lwlAuth$lockedOnServerThread()) {
			ackBlockChangesUpTo(packet.sequence());
			player.containerMenu.sendAllDataToRemote();
			ci.cancel();
		}
	}

	@Inject(method = "handleChat", at = @At("HEAD"), cancellable = true)
	private void lwlAuth$lockChat(ServerboundChatPacket packet, CallbackInfo ci) {
		if (lwlAuth$locked()) {
			player.sendSystemMessage(Component.literal("Чат откроется после входа: /login <пароль> или /register <пароль> <пароль>")
				.withStyle(ChatFormatting.RED));
			ci.cancel();
		}
	}

	@Unique
	private void lwlAuth$resendBlock(BlockPos pos) {
		if (player.level().isLoaded(pos)) {
			player.connection.send(new ClientboundBlockUpdatePacket(player.level(), pos));
		}
	}
}
