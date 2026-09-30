package ru.lwl.auth;

import javax.crypto.SecretKeyFactory;
import javax.crypto.spec.PBEKeySpec;
import java.security.GeneralSecurityException;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.Base64;

/**
 * Пароли хранятся только как PBKDF2-SHA256 с солью: из файла их не восстановить.
 * Формат: pbkdf2_sha256$итерации$соль$хеш (base64). Число итераций записано
 * в самой строке, поэтому его можно поднять, не ломая старые пароли.
 */
public final class Passwords {
	private static final String PREFIX = "pbkdf2_sha256";
	private static final int ITERATIONS = 600_000;
	private static final int SALT_BYTES = 16;
	private static final int HASH_BITS = 256;
	private static final SecureRandom RANDOM = new SecureRandom();

	private Passwords() {
	}

	public static String hash(String password) {
		byte[] salt = new byte[SALT_BYTES];
		RANDOM.nextBytes(salt);
		byte[] hash = pbkdf2(password, salt, ITERATIONS);
		Base64.Encoder b64 = Base64.getEncoder();
		return PREFIX + "$" + ITERATIONS + "$" + b64.encodeToString(salt) + "$" + b64.encodeToString(hash);
	}

	public static boolean verify(String password, String stored) {
		if (stored == null) {
			return false;
		}
		String[] parts = stored.split("\\$");
		if (parts.length != 4 || !parts[0].equals(PREFIX)) {
			return false;
		}
		try {
			int iterations = Integer.parseInt(parts[1]);
			byte[] salt = Base64.getDecoder().decode(parts[2]);
			byte[] expected = Base64.getDecoder().decode(parts[3]);
			return MessageDigest.isEqual(expected, pbkdf2(password, salt, iterations));
		} catch (IllegalArgumentException e) {
			return false;
		}
	}

	private static byte[] pbkdf2(String password, byte[] salt, int iterations) {
		PBEKeySpec spec = new PBEKeySpec(password.toCharArray(), salt, iterations, HASH_BITS);
		try {
			return SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256").generateSecret(spec).getEncoded();
		} catch (GeneralSecurityException e) {
			throw new IllegalStateException("PBKDF2 недоступен в этой Java", e);
		} finally {
			spec.clearPassword();
		}
	}
}
