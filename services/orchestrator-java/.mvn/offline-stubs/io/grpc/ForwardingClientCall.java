package io.grpc;

public abstract class ForwardingClientCall<ReqT, RespT> extends ClientCall<ReqT, RespT> {
    protected abstract ClientCall<ReqT, RespT> delegate();

    @Override
    public void start(Listener<RespT> responseListener, Metadata headers) {
        delegate().start(responseListener, headers);
    }

    @Override
    public void request(int numMessages) {
        delegate().request(numMessages);
    }

    @Override
    public void cancel(String message, Throwable cause) {
        delegate().cancel(message, cause);
    }

    @Override
    public void halfClose() {
        delegate().halfClose();
    }

    @Override
    public void sendMessage(ReqT message) {
        delegate().sendMessage(message);
    }

    public abstract static class SimpleForwardingClientCall<ReqT, RespT> extends ForwardingClientCall<ReqT, RespT> {
        private final ClientCall<ReqT, RespT> delegate;

        protected SimpleForwardingClientCall(ClientCall<ReqT, RespT> delegate) {
            this.delegate = delegate;
        }

        @Override
        protected ClientCall<ReqT, RespT> delegate() {
            return delegate;
        }
    }
}
