package com.chronosroute.orchestrator.grpc;

import io.grpc.CallOptions;
import io.grpc.Channel;
import io.grpc.ClientCall;
import io.grpc.ClientInterceptor;
import io.grpc.ForwardingClientCall;
import io.grpc.Metadata;
import io.grpc.MethodDescriptor;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicReference;

/**
 * gRPC {@link ClientInterceptor} that propagates the {@code x-trace-id} correlation header
 * on every outbound RPC to {@code solver-cpp}.
 */
public final class TraceIdClientInterceptor implements ClientInterceptor {

    public static final Metadata.Key<String> TRACE_ID_HEADER_KEY =
            Metadata.Key.of("x-trace-id", Metadata.ASCII_STRING_MARSHALLER);

    private static final ThreadLocal<String> CURRENT_TRACE_ID = new ThreadLocal<>();
    private final AtomicReference<String> lastPropagatedTraceId = new AtomicReference<>();

    public static void setCurrentTraceId(String traceId) {
        if (traceId == null || traceId.isBlank()) {
            CURRENT_TRACE_ID.remove();
        } else {
            CURRENT_TRACE_ID.set(traceId);
        }
    }

    public static String getCurrentTraceId() {
        return CURRENT_TRACE_ID.get();
    }

    public static void clearCurrentTraceId() {
        CURRENT_TRACE_ID.remove();
    }

    public String getLastPropagatedTraceId() {
        return lastPropagatedTraceId.get();
    }

    @Override
    public <ReqT, RespT> ClientCall<ReqT, RespT> interceptCall(
            MethodDescriptor<ReqT, RespT> method, CallOptions callOptions, Channel next) {
        final String traceId = resolveTraceId();
        return new ForwardingClientCall.SimpleForwardingClientCall<>(next.newCall(method, callOptions)) {
            @Override
            public void start(Listener<RespT> responseListener, Metadata headers) {
                headers.put(TRACE_ID_HEADER_KEY, traceId);
                lastPropagatedTraceId.set(traceId);
                super.start(responseListener, headers);
            }
        };
    }

    private static String resolveTraceId() {
        String existing = CURRENT_TRACE_ID.get();
        if (existing != null && !existing.isBlank()) {
            return existing;
        }
        return "trace-" + UUID.randomUUID();
    }
}
