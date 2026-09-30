package ru.lwl.skins;

/** Ошибка, текст которой можно показать игроку как есть. */
public class SkinException extends RuntimeException {
	public SkinException(String message) {
		super(message);
	}

	public SkinException(String message, Throwable cause) {
		super(message, cause);
	}

	/** Достаёт понятное игроку сообщение из любой ошибки CompletableFuture. */
	public static String userMessage(Throwable error) {
		Throwable t = error;
		while (t != null) {
			if (t instanceof SkinException) {
				return t.getMessage();
			}
			t = t.getCause();
		}
		return "Не удалось получить скин: сервис недоступен. Попробуйте позже.";
	}
}
