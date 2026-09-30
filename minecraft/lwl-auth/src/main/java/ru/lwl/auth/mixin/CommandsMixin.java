package ru.lwl.auth.mixin;

import com.mojang.brigadier.ParseResults;
import net.minecraft.ChatFormatting;
import net.minecraft.commands.CommandSourceStack;
import net.minecraft.commands.Commands;
import net.minecraft.network.chat.Component;
import net.minecraft.server.level.ServerPlayer;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;
import ru.lwl.auth.AuthCommands;
import ru.lwl.auth.AuthManager;

import java.util.Locale;

/** До входа работают только /login и /register — даже если у ника есть права оператора. */
@Mixin(Commands.class)
public abstract class CommandsMixin {
	@Inject(method = "performCommand", at = @At("HEAD"), cancellable = true)
	private void lwlAuth$onlyLoginBeforeAuth(ParseResults<CommandSourceStack> command, String commandString, CallbackInfo ci) {
		AuthManager manager = AuthManager.get();
		if (manager == null || !(command.getContext().getSource().getEntity() instanceof ServerPlayer player)
			|| manager.isAuthenticated(player)) {
			return;
		}
		String root = commandString.strip();
		if (root.startsWith("/")) {
			root = root.substring(1);
		}
		int space = root.indexOf(' ');
		root = (space < 0 ? root : root.substring(0, space)).toLowerCase(Locale.ROOT);
		if (!AuthCommands.ALLOWED_BEFORE_LOGIN.contains(root)) {
			player.sendSystemMessage(Component.literal("Сначала войдите: /login <пароль> или /register <пароль> <пароль>")
				.withStyle(ChatFormatting.RED));
			ci.cancel();
		}
	}
}
