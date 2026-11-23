package io.grpc;

public abstract class ClientCall<ReqT, RespT> {
    public abstract static class Listener<T> {
        public void onHeaders(Metadata headers) {}
        public void onMessage(T message) {}
        public void onClose(Status status, Metadata trailers) {}
        public void onReady() {}
    }

    public abstract void start(Listener<RespT> responseListener, Metadata headers);
    public abstract void request(int numMessages);
    public abstract void cancel(String message, Throwable cause);
    public abstract void halfClose();
    public abstract void sendMessage(ReqT message);
}
