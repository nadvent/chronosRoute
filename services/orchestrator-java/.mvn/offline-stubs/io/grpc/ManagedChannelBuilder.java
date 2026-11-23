package io.grpc;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.concurrent.TimeUnit;

public class ManagedChannelBuilder<T extends ManagedChannelBuilder<T>> {
    private final String target;
    private final List<ClientInterceptor> interceptors = new ArrayList<>();

    protected ManagedChannelBuilder(String target) {
        this.target = target;
    }

    public static ManagedChannelBuilder<?> forAddress(String name, int port) {
        return new ManagedChannelBuilder<>(name + ":" + port);
    }

    public static ManagedChannelBuilder<?> forTarget(String target) {
        return new ManagedChannelBuilder<>(target);
    }

    @SuppressWarnings("unchecked")
    public T usePlaintext() {
        return (T) this;
    }

    @SuppressWarnings("unchecked")
    public T intercept(ClientInterceptor... interceptorList) {
        this.interceptors.addAll(Arrays.asList(interceptorList));
        return (T) this;
    }

    public ManagedChannel build() {
        final String authority = this.target;
        final Channel base = new Channel() {
            @Override
            public <RequestT, ResponseT> ClientCall<RequestT, ResponseT> newCall(
                    MethodDescriptor<RequestT, ResponseT> methodDescriptor, CallOptions callOptions) {
                return new ClientCall<>() {
                    @Override
                    public void start(Listener<ResponseT> responseListener, Metadata headers) {}
                    @Override
                    public void request(int numMessages) {}
                    @Override
                    public void cancel(String message, Throwable cause) {}
                    @Override
                    public void halfClose() {}
                    @Override
                    public void sendMessage(RequestT message) {}
                };
            }

            @Override
            public String authority() {
                return authority;
            }
        };
        final Channel intercepted = ClientInterceptors.intercept(base, interceptors);
        return new ManagedChannel() {
            private volatile boolean shutdown = false;

            @Override
            public ManagedChannel shutdown() {
                shutdown = true;
                return this;
            }

            @Override
            public boolean isShutdown() {
                return shutdown;
            }

            @Override
            public boolean isTerminated() {
                return shutdown;
            }

            @Override
            public ManagedChannel shutdownNow() {
                shutdown = true;
                return this;
            }

            @Override
            public boolean awaitTermination(long timeout, TimeUnit unit) {
                return true;
            }

            @Override
            public <RequestT, ResponseT> ClientCall<RequestT, ResponseT> newCall(
                    MethodDescriptor<RequestT, ResponseT> methodDescriptor, CallOptions callOptions) {
                return intercepted.newCall(methodDescriptor, callOptions);
            }

            @Override
            public String authority() {
                return intercepted.authority();
            }
        };
    }
}
