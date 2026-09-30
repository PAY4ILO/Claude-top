package ru.lwl.auth;

import com.mojang.brigadier.CommandDispatcher;
import com.mojang.brigadier.builder.RequiredArgumentBuilder;
import com.mojang.brigadier.context.CommandContext;
import com.mojang.brigadier.tree.LiteralCommandNode;
import net.minecraft.ChatFormatting;
import net.minecraft.commands.CommandSourceStack;
import net.minecraft.commands.Commands;
import net.minecraft.commands.SharedSuggestionProvider;
import net.minecraft.network.chat.Component;

import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Set;

import static com.mojang.brigadier.arguments.StringArgumentType.getString;
import static com.mojang.brigadier.arguments.StringArgumentType.greedyString;
import static com.mojang.brigadier.arguments.StringArgumentType.word;
import static net.minecraft.commands.Commands.argument;
import static net.minecraft.commands.Commands.literal;

/**
 * /register <пароль> <пароль>, /login <пароль>, /changepassword <старый> <новый>
 * /auth … — для администрации.
 * У аргументов с паролем нет подсказок: так клиент не отправляет пароль на сервер,
 * пока игрок его набирает.
 */
public final class AuthCommands {
	/** Команды, доступные до входа. */
	public static final Set<String> ALLOWED_BEFORE_LOGIN = Set.of("login", "l", "register", "reg");

	private AuthCommands() {
	}

	public static void register(CommandDispatcher<CommandSourceStack> dispatcher) {
		LiteralCommandNode<CommandSourceStack> login = dispatcher.register(literal("login")
			.then(argument("пароль", greedyString()).executes(ctx -> {
				String[] words = words(ctx, "пароль");
				if (words.length != 1) {
					return usage(ctx, "/login <пароль> — в пароле не бывает пробелов.");
				}
				manager().login(ctx.getSource().getPlayerOrException(), words[0]);
				return 1;
			})));
		dispatcher.register(literal("l").redirect(login));

		LiteralCommandNode<CommandSourceStack> register = dispatcher.register(literal("register")
			.then(argument("пароль и повтор", greedyString()).executes(ctx -> {
				String[] words = words(ctx, "пароль и повтор");
				if (words.length != 2) {
					return usage(ctx, "Введите пароль два раза через пробел: /register <пароль> <пароль>");
				}
				manager().register(ctx.getSource().getPlayerOrException(), words[0], words[1]);
				return 1;
			})));
		dispatcher.register(literal("reg").redirect(register));

		dispatcher.register(literal("changepassword")
			.then(argument("старый и новый", greedyString()).executes(ctx -> {
				String[] words = words(ctx, "старый и новый");
				if (words.length != 2) {
					return usage(ctx, "/changepassword <старый пароль> <новый пароль>");
				}
				manager().changePassword(ctx.getSource().getPlayerOrException(), words[0], words[1]);
				return 1;
			})));

		dispatcher.register(literal("auth")
			.requires(Commands.hasPermission(Commands.LEVEL_ADMINS))
			.executes(ctx -> help(ctx.getSource()))
			.then(literal("info").then(player().executes(ctx -> info(ctx.getSource(), getString(ctx, "ник")))))
			.then(literal("resetpassword").then(player().executes(ctx -> {
				String name = getString(ctx, "ник");
				if (!manager().resetPassword(name)) {
					ctx.getSource().sendFailure(Component.literal("Игрок " + name + " ещё не заходил на сервер."));
					return 0;
				}
				ok(ctx.getSource(), "Пароль " + name + " сброшен: при входе он придумает новый через /register.");
				return 1;
			})))
			.then(literal("premium").then(player().executes(ctx -> {
				String name = getString(ctx, "ник");
				manager().setMode(name, Boolean.TRUE);
				ok(ctx.getSource(), name + " теперь входит только с лицензии, без пароля. Пароль удалён.");
				return 1;
			})))
			.then(literal("cracked").then(player().executes(ctx -> {
				String name = getString(ctx, "ник");
				manager().setMode(name, Boolean.FALSE);
				ok(ctx.getSource(), name + " теперь входит по паролю, даже если такой ник есть у лицензии.");
				return 1;
			})))
			.then(literal("auto").then(player().executes(ctx -> {
				String name = getString(ctx, "ник");
				manager().setMode(name, null);
				ok(ctx.getSource(), "Для " + name + " режим снова определяется автоматически.");
				return 1;
			})))
			.then(literal("unregister").then(player().executes(ctx -> {
				String name = getString(ctx, "ник");
				if (!manager().unregister(name)) {
					ctx.getSource().sendFailure(Component.literal("Аккаунта " + name + " нет."));
					return 0;
				}
				ok(ctx.getSource(), "Аккаунт " + name + " удалён.");
				return 1;
			})))
			.then(literal("reload").executes(ctx -> {
				manager().reloadConfig();
				ok(ctx.getSource(), "Настройки LWL Auth перечитаны.");
				return 1;
			})));
	}

	private static RequiredArgumentBuilder<CommandSourceStack, String> player() {
		return argument("ник", word())
			.suggests((ctx, builder) -> SharedSuggestionProvider.suggest(ctx.getSource().getServer().getPlayerNames(), builder));
	}

	private static int help(CommandSourceStack source) {
		source.sendSuccess(() -> Component.literal("""
			LWL Auth
			/auth info <ник> — как входит игрок
			/auth resetpassword <ник> — сбросить забытый пароль
			/auth premium <ник> — только лицензия, без пароля
			/auth cracked <ник> — только пароль (если ник совпал с чужой лицензией)
			/auth auto <ник> — снова определять автоматически
			/auth unregister <ник> — удалить аккаунт
			/auth reload — перечитать config/lwl-auth.json""").withStyle(ChatFormatting.GRAY), false);
		return 1;
	}

	private static int info(CommandSourceStack source, String name) {
		AuthStore.Account account = manager().store().get(name);
		if (account == null) {
			source.sendSuccess(() -> Component.literal(name + ": ещё не заходил. Режим определится при первом входе."), false);
			return 1;
		}
		String mode = Boolean.TRUE.equals(account.premium) ? "лицензия (без пароля)"
			: Boolean.FALSE.equals(account.premium) ? "только пароль"
			: account.passwordHash != null ? "пароль" : "автоматически";
		SimpleDateFormat date = new SimpleDateFormat("dd.MM.yyyy HH:mm");
		String text = account.name + ": " + mode
			+ (account.passwordHash != null ? ", пароль задан" : ", пароля нет")
			+ (account.lastLoginAt > 0 ? ", последний вход " + date.format(new Date(account.lastLoginAt)) : "");
		source.sendSuccess(() -> Component.literal(text), false);
		return 1;
	}

	private static String[] words(CommandContext<CommandSourceStack> ctx, String argument) {
		String value = getString(ctx, argument).trim();
		return value.isEmpty() ? new String[0] : value.split("\\s+");
	}

	private static int usage(CommandContext<CommandSourceStack> ctx, String message) {
		ctx.getSource().sendFailure(Component.literal(message));
		return 0;
	}

	private static void ok(CommandSourceStack source, String message) {
		source.sendSuccess(() -> Component.literal(message).withStyle(ChatFormatting.GREEN), true);
	}

	private static AuthManager manager() {
		AuthManager manager = AuthManager.get();
		if (manager == null) {
			throw new IllegalStateException("LWL Auth ещё не запущен");
		}
		return manager;
	}
}
