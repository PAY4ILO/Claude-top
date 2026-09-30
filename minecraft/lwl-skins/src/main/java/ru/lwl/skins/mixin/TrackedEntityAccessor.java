package ru.lwl.skins.mixin;

import net.minecraft.server.level.ServerEntity;
import net.minecraft.server.network.ServerPlayerConnection;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.gen.Accessor;

import java.util.Set;

@Mixin(targets = "net.minecraft.server.level.ChunkMap$TrackedEntity")
public interface TrackedEntityAccessor {
	@Accessor("serverEntity")
	ServerEntity lwlSkins$getServerEntity();

	@Accessor("seenBy")
	Set<ServerPlayerConnection> lwlSkins$getSeenBy();
}
