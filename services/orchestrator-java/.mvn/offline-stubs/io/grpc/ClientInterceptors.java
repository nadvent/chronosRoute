package io.grpc;

import java.util.Arrays;
import java.util.List;

public final class ClientInterceptors {
    private ClientInterceptors() {}

    public static Channel intercept(Channel channel, ClientInterceptor... interceptors) {
        return intercept(channel, Arrays.asList(interceptors));
    }

    public static Channel intercept(Channel channel, List<? extends ClientInterceptor> interceptors) {
        Channel current = channel;
        for (ClientInterceptor interceptor : interceptors) {
            final Channel next = current;
            final ClientInterceptor currentInterceptor = interceptor;
            current = new Channel() {
                @Override
                public <RequestT, ResponseT> ClientCall<RequestT, ResponseT> newCall(
                        MethodDescriptor<RequestT, ResponseT> methodDescriptor, CallOptions callOptions) {
                    return currentInterceptor.interceptCall(methodDescriptor, callOptions, next);
                }

                @Override
                public String authority() {
                    return next.authority();
                }
            };
        }
        return current;
    }
}
