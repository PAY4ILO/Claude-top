package ru.lwl.skins;

import net.fabricmc.api.ModInitializer;
import net.fabricmc.fabric.api.command.v2.CommandRegistrationCallback;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerLifecycleEvents;
import net.fabricmc.fabric.api.networking.v1.ServerPlayConnectionEvents;
import net.fabricmc.loader.api.FabricLoader;

/** Серверный мод скинов: /skin set <ник>, /skin url <ссылка> — как SkinsRestorer. */
public final class LwlSkins implements ModInitializer {
	@Override
	public void onInitialize() {
		ServerLifecycleEvents.SERVER_STARTING.register(server ->
			SkinManager.start(server, FabricLoader.getInstance().getConfigDir()));
		ServerLifecycleEvents.SERVER_STOPPED.register(server -> SkinManager.stop());
		CommandRegistrationCallback.EVENT.register((dispatcher, context, selection) ->
			SkinCommands.register(dispatcher));
		ServerPlayConnectionEvents.JOIN.register((handler, sender, server) -> {
			SkinManager manager = SkinManager.get();
			if (manager != null) {
				manager.onJoin(handler.getPlayer());
			}
		});
	}
}
