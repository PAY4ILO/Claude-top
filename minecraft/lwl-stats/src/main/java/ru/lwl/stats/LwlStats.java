package ru.lwl.stats;

import net.fabricmc.api.ModInitializer;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerLifecycleEvents;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerTickEvents;
import net.fabricmc.fabric.api.networking.v1.ServerPlayConnectionEvents;
import net.fabricmc.loader.api.FabricLoader;

/** Статистика игроков для карточек на сайте LWL: кто в игре и сколько наиграл. */
public final class LwlStats implements ModInitializer {
	@Override
	public void onInitialize() {
		ServerLifecycleEvents.SERVER_STARTED.register(server ->
			StatsManager.start(server, FabricLoader.getInstance().getConfigDir()));
		ServerLifecycleEvents.SERVER_STOPPING.register(server -> StatsManager.stop());
		ServerPlayConnectionEvents.JOIN.register((handler, sender, server) -> {
			StatsManager manager = StatsManager.get();
			if (manager != null) {
				manager.onJoin();
			}
		});
		ServerPlayConnectionEvents.DISCONNECT.register((handler, server) -> {
			StatsManager manager = StatsManager.get();
			if (manager != null) {
				manager.onLeave(handler.getPlayer());
			}
		});
		ServerTickEvents.END_SERVER_TICK.register(server -> {
			StatsManager manager = StatsManager.get();
			if (manager != null) {
				manager.tick();
			}
		});
	}
}
