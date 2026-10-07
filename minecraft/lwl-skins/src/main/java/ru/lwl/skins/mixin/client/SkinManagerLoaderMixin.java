package ru.lwl.skins.mixin.client;

import com.llamalad7.mixinextras.injector.wrapoperation.Operation;
import com.llamalad7.mixinextras.injector.wrapoperation.WrapOperation;
import com.mojang.authlib.minecraft.MinecraftProfileTextures;
import com.mojang.authlib.minecraft.SessionService;
import com.mojang.authlib.properties.Property;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import ru.lwl.skins.client.TrustedTextures;

/**
 * Загрузчик скинов клиента (анонимный CacheLoader внутри SkinManager): распаковка свойства «textures»
 * идёт в лямбде lambda$load$0. Оборачиваем вызов SessionService.unpackTextures — см. TrustedTextures.
 */
@Mixin(targets = "net.minecraft.client.resources.SkinManager$1")
public abstract class SkinManagerLoaderMixin {
	@WrapOperation(
		method = "lambda$load$0",
		at = @At(value = "INVOKE", target = "Lcom/mojang/authlib/minecraft/SessionService;unpackTextures(Lcom/mojang/authlib/properties/Property;)Lcom/mojang/authlib/minecraft/MinecraftProfileTextures;")
	)
	private static MinecraftProfileTextures lwl$trustMojangTextures(SessionService service, Property property, Operation<MinecraftProfileTextures> original) {
		MinecraftProfileTextures checked;
		try {
			checked = original.call(service, property);
		} catch (RuntimeException e) {
			// Сервисы Mojang недоступны: клиент не может узнать, с каких адресов разрешены скины.
			checked = null;
		}
		return TrustedTextures.unpack(property, checked);
	}
}
