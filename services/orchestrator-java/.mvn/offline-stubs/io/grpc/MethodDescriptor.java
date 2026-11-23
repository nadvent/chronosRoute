package io.grpc;

public final class MethodDescriptor<ReqT, RespT> {
    private final String fullMethodName;

    public MethodDescriptor(String fullMethodName) {
        this.fullMethodName = fullMethodName;
    }

    public String getFullMethodName() {
        return fullMethodName;
    }
}
