package io.grpc;

public abstract class Channel {
    public abstract <RequestT, ResponseT> ClientCall<RequestT, ResponseT> newCall(
            MethodDescriptor<RequestT, ResponseT> methodDescriptor, CallOptions callOptions);

    public abstract String authority();
}
