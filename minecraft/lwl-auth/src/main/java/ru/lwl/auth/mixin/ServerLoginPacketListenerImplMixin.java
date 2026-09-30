package ru.lwl.auth.mixin;

import com.llamalad7.mixinextras.injector.ModifyExpressionValue;
import com.mojang.authlib.GameProfile;
import net.minecraft.core.UUIDUtil;
import net.minecraft.network.Connection;
import net.minecraft.network.chat.Component;
import net.minecraft.network.protocol.login.ServerboundHelloPacket;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.network.ServerLoginPacketListenerImpl;
import net.minecraft.util.StringUtil;
import org.jspecify.annotations.Nullable;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.spongepowered.asm.mixin.Final;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.Shadow;
import org.spongepowered.asm.mixin.Unique;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.ModifyArg;
import org.spongepowered.asm.mixin.injection.ModifyVariable;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;
import ru.lwl.auth.AuthManager;

import java.util.Objects;

/**
 * Вход на сервер в режиме online-mode=false.
 * Ник лицензии → сервер просит клиента подтвердить аккаунт у Mojang (как в online-mode):
 * с пиратки под этим ником не зайти. Остальные ники → обычный офлайн-вход,
 * но соединение всё равно шифруется, чтобы пароль не шёл открытым текстом.
 */
@Mixin(ServerLoginPacketListenerImpl.class)
public abstract class ServerLoginPacketListenerImplMixin {
	@Unique
	private static final Logger LWL_AUTH$LOGGER = LoggerFactory.getLogger("LWL Auth");

	@Shadow
	@Final
	private MinecraftServer server;
	@Shadow
	@Final
	private Connection connection;
	@Shadow
	private @Nullable String requestedUsername;

	@Unique
	private volatile AuthManager.@Nullable Mode lwlAuth$mode;
	@Unique
	private volatile boolean lwlAuth$deciding;

	@Shadow
	public abstract void handleHello(ServerboundHelloPacket packet);

	@Shadow
	public abstract void disconnect(Component component);

	@Shadow
	private void startClientVerification(GameProfile profile) {
	}

	/** Сначала узнаём, лицензионный ли ник (у Mojang, с кешем), и только потом продолжаем вход. */
	@Inject(method = "handleHello", at = @At("HEAD"), cancellable = true)
	private void lwlAuth$decideMode(ServerboundHelloPacket packet, CallbackInfo ci) {
		AuthManager manager = AuthManager.get();
		if (manager == null || lwlAuth$mode != null || !StringUtil.isValidPlayerName(packet.name())) {
			return;
		}
		// Вайтлист проверяем первым: человеку не из списка незачем проходить проверку лицензии.
		Component rejected = manager.whitelistRejection(packet.name());
		if (rejected != null) {
			LWL_AUTH$LOGGER.info("{} не в вайтлисте — не пускаю", packet.name());
			disconnect(rejected);
			ci.cancel();
			return;
		}
		if (!manager.enabled()) {
			return;
		}
		ci.cancel();
		if (lwlAuth$deciding) {
			return;
		}
		lwlAuth$deciding = true;
		manager.decideMode(packet.name()).whenComplete((mode, error) -> {
			lwlAuth$mode = error != null || mode == null ? AuthManager.Mode.PASSWORD : mode;
			if (connection.isConnected()) {
				try {
					handleHello(packet);
				} catch (RuntimeException e) {
					LWL_AUTH$LOGGER.warn("Ошибка входа {}: {}", packet.name(), e.getMessage());
					connection.disconnect(Component.literal("Ошибка входа, попробуйте ещё раз."));
				}
			}
		});
	}

	/** Шифрование (и проверка лицензии) — как будто сервер в online-mode. */
	@ModifyExpressionValue(method = "handleHello", at = @At(value = "INVOKE", target = "Lnet/minecraft/server/MinecraftServer;usesAuthentication()Z"))
	private boolean lwlAuth$useEncryption(boolean original) {
		AuthManager manager = AuthManager.get();
		AuthManager.Mode mode = lwlAuth$mode;
		if (original || manager == null || mode == null) {
			return original;
		}
		return mode == AuthManager.Mode.PREMIUM || manager.config().encryptOfflineConnections;
	}

	/** Клиенту без лицензии говорим «не ходи в Mojang», он просто включит шифрование. */
	@ModifyArg(method = "handleHello", at = @At(value = "INVOKE", target = "Lnet/minecraft/network/protocol/login/ClientboundHelloPacket;<init>(Ljava/lang/String;[B[BZ)V"), index = 3)
	private boolean lwlAuth$shouldAuthenticate(boolean original) {
		AuthManager.Mode mode = lwlAuth$mode;
		return mode == null ? original : mode == AuthManager.Mode.PREMIUM;
	}

	/** Для входа по паролю не спрашиваем Mojang: сразу офлайн-профиль (соединение уже зашифровано). */
	@Inject(method = "handleKey", at = @At(value = "INVOKE", target = "Ljava/lang/Thread;start()V"), cancellable = true)
	private void lwlAuth$skipMojangForPassword(CallbackInfo ci) {
		if (lwlAuth$mode == AuthManager.Mode.PASSWORD) {
			startClientVerification(UUIDUtil.createOfflineProfile(Objects.requireNonNull(requestedUsername)));
			ci.cancel();
		}
	}

	/** Mojang подтвердил лицензию: запоминаем это и (по настройке) оставляем офлайн-UUID. */
	@ModifyVariable(method = "startClientVerification", at = @At("HEAD"), argsOnly = true)
	private GameProfile lwlAuth$premiumProfile(GameProfile profile) {
		AuthManager manager = AuthManager.get();
		if (manager == null || lwlAuth$mode != AuthManager.Mode.PREMIUM) {
			return profile;
		}
		manager.markPremiumVerified(profile.name());
		LWL_AUTH$LOGGER.info("{} вошёл с лицензии", profile.name());
		if (!manager.config().keepOfflineUuid) {
			return profile;
		}
		return new GameProfile(UUIDUtil.createOfflinePlayerUUID(profile.name()), profile.name(), profile.properties());
	}

	/** С паролем нельзя «выбить» с сервера игрока, который уже вошёл под этим ником. */
	@Inject(method = "verifyLoginAndFinishConnectionSetup", at = @At("HEAD"), cancellable = true)
	private void lwlAuth$protectOnlinePlayer(GameProfile profile, CallbackInfo ci) {
		AuthManager manager = AuthManager.get();
		if (manager != null && lwlAuth$mode == AuthManager.Mode.PASSWORD && manager.isOnlineAndLoggedIn(profile.name())) {
			disconnect(Component.literal("Игрок с ником " + profile.name() + " уже на сервере."));
			ci.cancel();
		}
	}
}
