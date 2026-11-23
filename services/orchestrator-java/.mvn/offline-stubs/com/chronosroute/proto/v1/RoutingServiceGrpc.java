package com.chronosroute.proto.v1;

import io.grpc.CallOptions;
import io.grpc.Channel;
import io.grpc.ClientCall;
import io.grpc.ClientInterceptor;
import io.grpc.ClientInterceptors;
import io.grpc.Deadline;
import io.grpc.Metadata;
import io.grpc.MethodDescriptor;
import java.util.concurrent.TimeUnit;
import java.util.function.Function;

public final class RoutingServiceGrpc {
    public static final MethodDescriptor<CVRPTWRequest, CVRPTWResponse> SOLVE_CVRPTW_METHOD =
            new MethodDescriptor<>("chronos.routing.v1.RoutingService/SolveCVRPTW");
    public static final MethodDescriptor<TrafficUpdateRequest, TrafficUpdateResponse> UPDATE_TRAFFIC_METHOD =
            new MethodDescriptor<>("chronos.routing.v1.RoutingService/UpdateTrafficMultipliers");
    public static final MethodDescriptor<HealthRequest, HealthResponse> CHECK_HEALTH_METHOD =
            new MethodDescriptor<>("chronos.routing.v1.RoutingService/CheckHealth");

    public static MethodDescriptor<CVRPTWRequest, CVRPTWResponse> getSolveCVRPTWMethod() {
        return SOLVE_CVRPTW_METHOD;
    }

    private RoutingServiceGrpc() {}

    public static RoutingServiceBlockingStub newBlockingStub(Channel channel) {
        return new RoutingServiceBlockingStub(channel, CallOptions.DEFAULT, null);
    }

    public static class RoutingServiceBlockingStub {
        private final Channel channel;
        private final CallOptions callOptions;
        private final Function<CVRPTWRequest, CVRPTWResponse> handler;

        public RoutingServiceBlockingStub(
                Channel channel,
                CallOptions callOptions,
                Function<CVRPTWRequest, CVRPTWResponse> handler) {
            this.channel = channel;
            this.callOptions = callOptions;
            this.handler = handler;
        }

        public RoutingServiceBlockingStub withDeadlineAfter(long duration, TimeUnit units) {
            return new RoutingServiceBlockingStub(
                    this.channel,
                    this.callOptions.withDeadlineAfter(duration, units),
                    this.handler);
        }

        public RoutingServiceBlockingStub withInterceptors(ClientInterceptor... interceptors) {
            return new RoutingServiceBlockingStub(
                    ClientInterceptors.intercept(this.channel, interceptors),
                    this.callOptions,
                    this.handler);
        }

        public RoutingServiceBlockingStub withHandler(Function<CVRPTWRequest, CVRPTWResponse> customHandler) {
            return new RoutingServiceBlockingStub(this.channel, this.callOptions, customHandler);
        }

        public CallOptions getCallOptions() {
            return callOptions;
        }

        public Deadline getDeadline() {
            return callOptions.getDeadline();
        }

        public CVRPTWResponse solveCVRPTW(CVRPTWRequest request) {
            ClientCall<CVRPTWRequest, CVRPTWResponse> call =
                    channel.newCall(SOLVE_CVRPTW_METHOD, callOptions);
            Metadata headers = new Metadata();
            call.start(new ClientCall.Listener<>() {}, headers);
            call.sendMessage(request);
            call.halfClose();
            if (handler != null) {
                return handler.apply(request);
            }
            throw io.grpc.Status.UNAVAILABLE
                    .withDescription("Offline stub solver unavailable")
                    .asRuntimeException();
        }

        public TrafficUpdateResponse updateTrafficMultipliers(TrafficUpdateRequest request) {
            throw io.grpc.Status.UNAVAILABLE
                    .withDescription("Offline stub solver unavailable")
                    .asRuntimeException();
        }

        public HealthResponse checkHealth(HealthRequest request) {
            throw io.grpc.Status.UNAVAILABLE
                    .withDescription("Offline stub solver unavailable")
                    .asRuntimeException();
        }
    }
}
