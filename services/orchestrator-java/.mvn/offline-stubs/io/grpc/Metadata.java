package io.grpc;

import java.util.HashMap;
import java.util.Locale;
import java.util.Map;

public final class Metadata {
    public static final AsciiMarshaller<String> ASCII_STRING_MARSHALLER = new AsciiMarshaller<>() {
        @Override
        public String toAsciiString(String value) {
            return value;
        }

        @Override
        public String parseAsciiString(String serialized) {
            return serialized;
        }
    };

    private final Map<String, String> headers = new HashMap<>();

    public interface AsciiMarshaller<T> {
        String toAsciiString(T value);
        T parseAsciiString(String serialized);
    }

    public static final class Key<T> {
        private final String name;
        private final AsciiMarshaller<T> marshaller;

        private Key(String name, AsciiMarshaller<T> marshaller) {
            this.name = name.toLowerCase(Locale.ROOT);
            this.marshaller = marshaller;
        }

        public static <T> Key<T> of(String name, AsciiMarshaller<T> marshaller) {
            return new Key<>(name, marshaller);
        }

        public String name() {
            return name;
        }

        public AsciiMarshaller<T> marshaller() {
            return marshaller;
        }
    }

    public <T> void put(Key<T> key, T value) {
        if (key != null && value != null) {
            headers.put(key.name(), key.marshaller().toAsciiString(value));
        }
    }

    public <T> T get(Key<T> key) {
        String raw = headers.get(key.name());
        return raw == null ? null : key.marshaller().parseAsciiString(raw);
    }

    public void merge(Metadata other) {
        if (other != null) {
            headers.putAll(other.headers);
        }
    }
}
