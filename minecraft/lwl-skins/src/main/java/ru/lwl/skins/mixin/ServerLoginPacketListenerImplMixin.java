package ru.lwl.skins.mixin;

import com.mojang.authlib.GameProfile;
import net.minecraft.server.network.ServerLoginPacketListenerImpl;
import org.jspecify.annotations.Nullable;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.Shadow;
import org.spongepowered.asm.mixin.Unique;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;
import ru.lwl.skins.Skin;
import ru.lwl.skins.SkinManager;

import java.util.Optional;
import java.util.concurrent.CompletableFuture;

/**
 * Подменяет текстуры в профиле до того, как игрок попадёт в мир, — так скин
 * сразу виден всем, без мигания. Сервер вызывает метод каждый тик, пока игрок
 * «проверяется», поэтому можно спокойно отменять вызов, пока скин грузится.
 */
@Mixin(ServerLoginPacketListenerImpl.class)
public abstract class ServerLoginPacketListenerImplMixin {
	@Unique
	private static final Logger LWL_SKINS$LOGGER = LoggerFactory.getLogger("LWL Skins");

	@Shadow
	private @Nullable GameProfile authenticatedProfile;

	@Unique
	private @Nullable CompletableFuture<Optional<Skin>> lwlSkins$lookup;
	@Unique
	private long lwlSkins$startedAt;
	@Unique
	private boolean lwlSkins$done;

	@Inject(method = "verifyLoginAndFinishConnectionSetup", at = @At("HEAD"), cancellable = true)
	private void lwlSkins$waitForSkin(GameProfile profile, CallbackInfo ci) {
		if (lwlSkins$done) {
			return;
		}
		SkinManager manager = SkinManager.get();
		if (manager == null) {
			lwlSkins$done = true;
			return;
		}
		if (lwlSkins$lookup == null) {
			lwlSkins$lookup = manager.resolveForLogin(profile);
			lwlSkins$startedAt = System.nanoTime();
		}
		if (!lwlSkins$lookup.isDone()) {
			long waited = (System.nanoTime() - lwlSkins$startedAt) / 1_000_000L;
			if (waited < manager.config().loginWaitMillis) {
				ci.cancel();
				return;
			}
			// Не ждём дольше: пустим без скина, он приедет сам после входа.
			LWL_SKINS$LOGGER.info("Скин для {} ещё грузится, пускаю без него", profile.name());
			lwlSkins$done = true;
			return;
		}
		lwlSkins$done = true;
		Optional<Skin> skin = lwlSkins$lookup.exceptionally(error -> Optional.empty()).join();
		if (skin.isPresent()) {
			// Следующий тик сервер вызовет этот метод уже с новым профилем.
			authenticatedProfile = SkinManager.withSkin(profile, skin.get());
			ci.cancel();
		}
	}
}
