package ru.lwl.skins;

import com.mojang.brigadier.CommandDispatcher;
import com.mojang.brigadier.builder.ArgumentBuilder;
import com.mojang.brigadier.builder.LiteralArgumentBuilder;
import com.mojang.brigadier.context.CommandContext;
import com.mojang.brigadier.exceptions.CommandSyntaxException;
import com.mojang.brigadier.suggestion.SuggestionProvider;
import com.mojang.brigadier.suggestion.SuggestionsBuilder;
import net.minecraft.ChatFormatting;
import net.minecraft.commands.CommandSourceStack;
import net.minecraft.commands.Commands;
import net.minecraft.commands.SharedSuggestionProvider;
import net.minecraft.network.chat.ClickEvent;
import net.minecraft.network.chat.Component;
import net.minecraft.network.chat.HoverEvent;
import net.minecraft.network.chat.MutableComponent;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.server.permissions.Permissions;

import java.net.URI;
import java.util.List;
import java.util.Locale;

import static com.mojang.brigadier.arguments.StringArgumentType.getString;
import static com.mojang.brigadier.arguments.StringArgumentType.greedyString;
import static com.mojang.brigadier.arguments.StringArgumentType.word;
import static net.minecraft.commands.Commands.argument;
import static net.minecraft.commands.Commands.literal;

/**
 * /skin set <ник>            — скин лицензионного аккаунта
 * /skin url <ссылка> [slim]  — скин из PNG по ссылке
 * /skin clear                — вернуть скин по умолчанию
 * /skin update               — перекачать текущий скин
 * /skin of <игрок> …         — то же для другого игрока (админ)
 * /skin reload               — перечитать настройки (админ)
 */
public final class SkinCommands {
	private static final SuggestionProvider<CommandSourceStack> ONLINE_PLAYERS =
		(ctx, builder) -> SharedSuggestionProvider.suggest(ctx.getSource().getServer().getPlayerNames(), builder);

	/** Внутри «ссылка slim» подсказываем только вторую часть. */
	private static final SuggestionProvider<CommandSourceStack> URL_VARIANT = (ctx, builder) -> {
		String remaining = builder.getRemaining();
		int space = remaining.indexOf(' ');
		if (space < 0) {
			return builder.buildFuture();
		}
		SuggestionsBuilder variant = builder.createOffset(builder.getStart() + space + 1);
		String typed = variant.getRemaining().toLowerCase(Locale.ROOT);
		for (String option : List.of("slim", "classic")) {
			if (option.startsWith(typed)) {
				variant.suggest(option);
			}
		}
		return variant.buildFuture();
	};

	private SkinCommands() {
	}

	public static void register(CommandDispatcher<CommandSourceStack> dispatcher) {
		LiteralArgumentBuilder<CommandSourceStack> root = literal("skin")
			.executes(ctx -> help(ctx.getSource()));
		addActions(root, ctx -> self(ctx.getSource()));
		root.then(literal("of")
			.requires(Commands.hasPermission(Commands.LEVEL_GAMEMASTERS))
			.then(addActions(argument("игрок", word()).suggests(ONLINE_PLAYERS), ctx -> other(ctx.getSource(), getString(ctx, "игрок")))));
		root.then(literal("reload")
			.requires(Commands.hasPermission(Commands.LEVEL_GAMEMASTERS))
			.executes(ctx -> {
				manager().reloadConfig();
				ctx.getSource().sendSuccess(() -> Component.literal("Настройки LWL Skins перечитаны.").withStyle(ChatFormatting.GREEN), true);
				return 1;
			}));
		dispatcher.register(root);
	}

	private static <T extends ArgumentBuilder<CommandSourceStack, T>> T addActions(T parent, TargetResolver target) {
		parent.then(literal("set")
			.then(argument("ник", word()).suggests(ONLINE_PLAYERS)
				.executes(ctx -> setFromNickname(ctx.getSource(), target.resolve(ctx), getString(ctx, "ник")))));
		parent.then(literal("url")
			.then(argument("ссылка", greedyString()).suggests(URL_VARIANT)
				.executes(ctx -> setFromUrl(ctx.getSource(), target.resolve(ctx), getString(ctx, "ссылка")))));
		parent.then(literal("clear")
			.executes(ctx -> clear(ctx.getSource(), target.resolve(ctx))));
		parent.then(literal("update")
			.executes(ctx -> update(ctx.getSource(), target.resolve(ctx))));
		return parent;
	}

	@FunctionalInterface
	private interface TargetResolver {
		Target resolve(CommandContext<CommandSourceStack> ctx) throws CommandSyntaxException;
	}

	/** Чей скин меняем. self — игрок меняет себе (действуют кулдаун и запрет из настроек). */
	private record Target(String name, boolean self) {
		String whose() {
			return self ? "Ваш скин" : "Скин игрока " + name;
		}
	}

	private static Target self(CommandSourceStack source) throws CommandSyntaxException {
		return new Target(source.getPlayerOrException().getGameProfile().name(), true);
	}

	private static Target other(CommandSourceStack source, String name) {
		ServerPlayer online = source.getServer().getPlayerList().getPlayer(name);
		return new Target(online != null ? online.getGameProfile().name() : name, false);
	}

	// ---------- команды ----------

	private static int setFromNickname(CommandSourceStack source, Target target, String nick) {
		if (!SkinFetcher.isValidNickname(nick)) {
			source.sendFailure(Component.literal("Ник «" + nick + "» не может быть лицензионным: только латиница, цифры и _, до 16 символов."));
			return 0;
		}
		if (!allowed(source, target)) {
			return 0;
		}
		info(source, "Ищу скин лицензии " + nick + "…");
		SkinManager manager = manager();
		manager.fetchNickname(nick).whenCompleteAsync((skin, error) -> {
			if (error != null) {
				source.sendFailure(Component.literal(SkinException.userMessage(error)));
			} else if (skin.isEmpty()) {
				source.sendFailure(Component.literal("Лицензионного аккаунта с ником " + nick + " нет — скин взять неоткуда. Проверьте написание или используйте /skin url."));
			} else {
				manager.setSkin(target.name(), new SkinStore.PlayerSkin(target.name(), "nick", nick, skin.get().isSlim(), skin.get()));
				success(source, target, target.whose() + " теперь как у " + nick + ".", skin.get());
			}
		}, manager.server());
		return 1;
	}

	private static int setFromUrl(CommandSourceStack source, Target target, String input) {
		String[] parts = input.trim().split("\\s+");
		boolean slim;
		if (parts.length == 1) {
			slim = false;
		} else if (parts.length == 2 && parts[1].equalsIgnoreCase("slim")) {
			slim = true;
		} else if (parts.length == 2 && parts[1].equalsIgnoreCase("classic")) {
			slim = false;
		} else {
			source.sendFailure(Component.literal("Формат: /skin url <ссылка на PNG> [slim]. slim — тонкие руки (как у Алекс)."));
			return 0;
		}
		String url = parts[0];
		try {
			SkinFetcher.checkUrl(url);
		} catch (SkinException e) {
			source.sendFailure(Component.literal(e.getMessage()));
			return 0;
		}
		if (!allowed(source, target)) {
			return 0;
		}
		info(source, "Загружаю скин по ссылке, это займёт несколько секунд…");
		SkinManager manager = manager();
		manager.fetchUrl(url, slim).whenCompleteAsync((skin, error) -> {
			if (error != null) {
				source.sendFailure(Component.literal(SkinException.userMessage(error)));
			} else {
				manager.setSkin(target.name(), new SkinStore.PlayerSkin(target.name(), "url", url, slim, skin));
				success(source, target, target.whose() + " обновлён.", skin);
			}
		}, manager.server());
		return 1;
	}

	private static int clear(CommandSourceStack source, Target target) {
		SkinManager manager = manager();
		if (manager.store().get(target.name()) == null) {
			source.sendFailure(Component.literal(target.self()
				? "У вас и так скин по умолчанию."
				: "У игрока " + target.name() + " не выбран свой скин."));
			return 0;
		}
		if (!allowed(source, target)) {
			return 0;
		}
		manager.clearSkin(target.name()).whenComplete((ignored, error) ->
			manager.server().execute(() -> source.sendSuccess(() -> Component.literal(target.whose() + " сброшен.").withStyle(ChatFormatting.GREEN), !target.self())));
		return 1;
	}

	private static int update(CommandSourceStack source, Target target) {
		SkinManager manager = manager();
		SkinStore.PlayerSkin chosen = manager.store().get(target.name());
		if (chosen == null) {
			if (!manager.config().skinFromNickname) {
				source.sendFailure(Component.literal("Свой скин не выбран — обновлять нечего."));
				return 0;
			}
			if (!allowed(source, target)) {
				return 0;
			}
			info(source, "Проверяю скин лицензии " + target.name() + "…");
			manager.fetchNickname(target.name()).whenCompleteAsync((skin, error) -> {
				if (error != null) {
					source.sendFailure(Component.literal(SkinException.userMessage(error)));
					return;
				}
				ServerPlayer player = manager.server().getPlayerList().getPlayer(target.name());
				if (skin.isEmpty()) {
					source.sendFailure(Component.literal("Лицензии с ником " + target.name() + " нет. Выберите скин: /skin set <ник> или /skin url <ссылка>."));
				} else if (player != null) {
					manager.apply(player, skin.get());
					success(source, target, target.whose() + " обновлён.", skin.get());
				} else {
					success(source, target, "Скин лицензии обновлён, игрок увидит его при входе.", skin.get());
				}
			}, manager.server());
			return 1;
		}
		return chosen.source.equals("url")
			? setFromUrl(source, target, chosen.input + (chosen.slim ? " slim" : ""))
			: setFromNickname(source, target, chosen.input);
	}

	private static int help(CommandSourceStack source) {
		SkinManager manager = manager();
		MutableComponent text = Component.literal("Скины LWL\n").withStyle(ChatFormatting.GOLD, ChatFormatting.BOLD);
		ServerPlayer player = source.getPlayer();
		if (player != null) {
			SkinStore.PlayerSkin chosen = manager.store().get(player.getGameProfile().name());
			String now = chosen == null
				? (manager.current(player) != null ? "скин по умолчанию (из лицензии)" : "без скина (Стив/Алекс)")
				: chosen.source.equals("url") ? "по ссылке" : "как у " + chosen.input;
			text.append(Component.literal("Сейчас: " + now + "\n").withStyle(ChatFormatting.GRAY).withStyle(s -> s.withBold(false)));
		}
		text.append(line("/skin set <ник>", "скин любого лицензионного игрока", "/skin set "));
		text.append(line("/skin url <ссылка>", "скин из PNG по прямой ссылке", "/skin url "));
		text.append(line("/skin url <ссылка> slim", "то же с тонкими руками", "/skin url "));
		text.append(line("/skin update", "перекачать скин (если он поменялся)", "/skin update"));
		text.append(line("/skin clear", "вернуть скин по умолчанию", "/skin clear"));
		if (source.permissions().hasPermission(Permissions.COMMANDS_GAMEMASTER)) {
			text.append(line("/skin of <игрок> set|url|update|clear", "то же для другого игрока", "/skin of "));
			text.append(line("/skin reload", "перечитать config/lwl-skins.json", "/skin reload"));
		}
		source.sendSuccess(() -> text, false);
		return 1;
	}

	// ---------- помощники ----------

	private static MutableComponent line(String command, String description, String suggest) {
		return Component.literal(command).withStyle(style -> style.withColor(ChatFormatting.YELLOW).withBold(false)
				.withClickEvent(new ClickEvent.SuggestCommand(suggest))
				.withHoverEvent(new HoverEvent.ShowText(Component.literal("Нажмите, чтобы вставить команду"))))
			.append(Component.literal(" — " + description + "\n").withStyle(ChatFormatting.GRAY));
	}

	/** Можно ли выполнить команду: запрет из настроек и кулдаун действуют только на обычных игроков. */
	private static boolean allowed(CommandSourceStack source, Target target) {
		if (!target.self() || source.permissions().hasPermission(Permissions.COMMANDS_GAMEMASTER)) {
			return true;
		}
		SkinManager manager = manager();
		if (!manager.config().allowPlayersToChangeSkin) {
			source.sendFailure(Component.literal("Скин может поменять только администрация."));
			return false;
		}
		ServerPlayer player = source.getPlayer();
		if (player == null) {
			return true;
		}
		long left = manager.cooldownLeft(player.getUUID());
		if (left > 0) {
			source.sendFailure(Component.literal("Подождите ещё " + left + " сек. перед следующей сменой скина."));
			return false;
		}
		manager.startCooldown(player.getUUID());
		return true;
	}

	private static void info(CommandSourceStack source, String message) {
		source.sendSuccess(() -> Component.literal(message).withStyle(ChatFormatting.GRAY), false);
	}

	private static void success(CommandSourceStack source, Target target, String message, Skin skin) {
		MutableComponent text = Component.literal(message + " ").withStyle(ChatFormatting.GREEN);
		String url = skin.textureUrl();
		if (url != null) {
			text.append(Component.literal("[картинка]").withStyle(style -> style.withColor(ChatFormatting.AQUA)
				.withClickEvent(new ClickEvent.OpenUrl(URI.create(url)))
				.withHoverEvent(new HoverEvent.ShowText(Component.literal("Открыть файл скина")))));
		}
		source.sendSuccess(() -> text, !target.self());
	}

	private static SkinManager manager() {
		SkinManager manager = SkinManager.get();
		if (manager == null) {
			throw new IllegalStateException("LWL Skins ещё не запущен");
		}
		return manager;
	}
}
