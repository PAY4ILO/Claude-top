package ru.lwl.auth.mixin;

import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.server.permissions.PermissionSet;
import net.minecraft.world.damagesource.DamageSource;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;
import ru.lwl.auth.AuthManager;

@Mixin(ServerPlayer.class)
public abstract class ServerPlayerMixin {
	/** Не вошёл — нет прав оператора: зайти под ником админа и что-то сломать не выйдет. */
	@Inject(method = "permissions", at = @At("HEAD"), cancellable = true)
	private void lwlAuth$noPermissionsBeforeLogin(CallbackInfoReturnable<PermissionSet> cir) {
		AuthManager manager = AuthManager.get();
		if (manager != null && !manager.isAuthenticated((ServerPlayer) (Object) this)) {
			cir.setReturnValue(PermissionSet.NO_PERMISSIONS);
		}
	}

	/** Пока игрок вводит пароль, его нельзя убить. */
	@Inject(method = "hurtServer", at = @At("HEAD"), cancellable = true)
	private void lwlAuth$invulnerableBeforeLogin(ServerLevel level, DamageSource source, float damage, CallbackInfoReturnable<Boolean> cir) {
		AuthManager manager = AuthManager.get();
		if (manager != null && !manager.isAuthenticated((ServerPlayer) (Object) this)) {
			cir.setReturnValue(false);
		}
	}
}
