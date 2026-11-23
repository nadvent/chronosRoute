package org.junit.jupiter.api;

import java.util.Objects;
import org.junit.jupiter.api.function.Executable;

public final class Assertions {
    private Assertions() {}

    public static void assertTrue(boolean condition) {
        assertTrue(condition, "Expected condition to be true, but was false");
    }

    public static void assertTrue(boolean condition, String message) {
        if (!condition) {
            throw new AssertionError(message);
        }
    }

    public static void assertFalse(boolean condition) {
        assertFalse(condition, "Expected condition to be false, but was true");
    }

    public static void assertFalse(boolean condition, String message) {
        if (condition) {
            throw new AssertionError(message);
        }
    }

    public static void assertEquals(Object expected, Object actual) {
        assertEquals(expected, actual, "Expected <" + expected + "> but was <" + actual + ">");
    }

    public static void assertEquals(Object expected, Object actual, String message) {
        if (!Objects.equals(expected, actual)) {
            throw new AssertionError(message + " (expected: <" + expected + ">, actual: <" + actual + ">)");
        }
    }

    public static void assertEquals(long expected, long actual) {
        if (expected != actual) {
            throw new AssertionError("Expected <" + expected + "> but was <" + actual + ">");
        }
    }

    public static void assertEquals(long expected, long actual, String message) {
        if (expected != actual) {
            throw new AssertionError(message + " (expected: <" + expected + ">, actual: <" + actual + ">)");
        }
    }

    public static void assertEquals(double expected, double actual, double delta) {
        if (Math.abs(expected - actual) > delta) {
            throw new AssertionError("Expected <" + expected + "> within <" + delta + "> but was <" + actual + ">");
        }
    }

    public static void assertNotEquals(Object unexpected, Object actual) {
        if (Objects.equals(unexpected, actual)) {
            throw new AssertionError("Expected not equal to <" + unexpected + ">");
        }
    }

    public static void assertNotNull(Object actual) {
        assertNotNull(actual, "Expected non-null value");
    }

    public static void assertNotNull(Object actual, String message) {
        if (actual == null) {
            throw new AssertionError(message);
        }
    }

    public static void assertNull(Object actual) {
        assertNull(actual, "Expected null value, but was <" + actual + ">");
    }

    public static void assertNull(Object actual, String message) {
        if (actual != null) {
            throw new AssertionError(message);
        }
    }

    public static <T extends Throwable> T assertThrows(Class<T> expectedType, Executable executable) {
        return assertThrows(expectedType, executable, "Expected " + expectedType.getName() + " to be thrown");
    }

    @SuppressWarnings("unchecked")
    public static <T extends Throwable> T assertThrows(Class<T> expectedType, Executable executable, String message) {
        try {
            executable.execute();
        } catch (Throwable actualException) {
            if (expectedType.isInstance(actualException)) {
                return (T) actualException;
            }
            throw new AssertionError(
                    message + " — unexpected exception type thrown: " + actualException.getClass().getName(),
                    actualException);
        }
        throw new AssertionError(message + " — nothing was thrown");
    }

    public static void assertDoesNotThrow(Executable executable) {
        try {
            executable.execute();
        } catch (Throwable t) {
            throw new AssertionError("Expected no exception to be thrown, but got: " + t, t);
        }
    }

    public static <T> T fail(String message) {
        throw new AssertionError(message);
    }
}
