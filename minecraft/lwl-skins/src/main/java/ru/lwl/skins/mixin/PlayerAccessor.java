package ru.lwl.skins.mixin;

import com.mojang.authlib.GameProfile;
import net.minecraft.world.entity.player.Player;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.Mutable;
import org.spongepowered.asm.mixin.gen.Accessor;

/** Профиль игрока в игре final — открываем его для замены текстур. */
@Mixin(Player.class)
public interface PlayerAccessor {
	@Mutable
	@Accessor("gameProfile")
	void lwlSkins$setGameProfile(GameProfile profile);
}
