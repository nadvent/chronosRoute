package org.springframework.http;

public class ResponseEntity<T> {
    private final HttpStatus status;
    private final T body;

    public ResponseEntity(T body, HttpStatus status) {
        this.body = body;
        this.status = status;
    }

    public static <T> ResponseEntity<T> ok(T body) {
        return new ResponseEntity<>(body, HttpStatus.OK);
    }

    public static <T> ResponseEntity<T> status(HttpStatus status) {
        return new ResponseEntity<>(null, status);
    }

    public static <T> ResponseEntity<T> status(int code, T body) {
        for (HttpStatus s : HttpStatus.values()) {
            if (s.value() == code) {
                return new ResponseEntity<>(body, s);
            }
        }
        return new ResponseEntity<>(body, HttpStatus.OK);
    }

    public HttpStatus getStatusCode() {
        return status;
    }

    public int getStatusCodeValue() {
        return status.value();
    }

    public T getBody() {
        return body;
    }
}
