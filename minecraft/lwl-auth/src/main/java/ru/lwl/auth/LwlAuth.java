package ru.lwl.auth;

import net.fabricmc.api.ModInitializer;
import net.fabricmc.fabric.api.command.v2.CommandRegistrationCallback;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerLifecycleEvents;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerTickEvents;
import net.fabricmc.fabric.api.networking.v1.ServerPlayConnectionEvents;
import net.fabricmc.loader.api.FabricLoader;

/** Авторизация: лицензия — без пароля, остальные — /register и /login. */
public final class LwlAuth implements ModInitializer {
	@Override
	public void onInitialize() {
		ServerLifecycleEvents.SERVER_STARTING.register(server ->
			AuthManager.start(server, FabricLoader.getInstance().getConfigDir()));
		ServerLifecycleEvents.SERVER_STOPPED.register(server -> AuthManager.stop());
		CommandRegistrationCallback.EVENT.register((dispatcher, context, selection) ->
			AuthCommands.register(dispatcher));
		ServerPlayConnectionEvents.JOIN.register((handler, sender, server) -> {
			AuthManager manager = AuthManager.get();
			if (manager != null) {
				manager.onJoin(handler.getPlayer());
			}
		});
		ServerPlayConnectionEvents.DISCONNECT.register((handler, server) -> {
			AuthManager manager = AuthManager.get();
			if (manager != null) {
				manager.onLeave(handler.getPlayer());
			}
		});
		ServerTickEvents.END_SERVER_TICK.register(server -> {
			AuthManager manager = AuthManager.get();
			if (manager != null) {
				manager.tick();
			}
		});
	}
}
