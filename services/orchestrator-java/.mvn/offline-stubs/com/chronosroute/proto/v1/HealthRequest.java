package com.chronosroute.proto.v1;

public final class HealthRequest {
    private final String clientId;

    private HealthRequest(Builder b) {
        this.clientId = b.clientId;
    }

    public String getClientId() { return clientId; }

    public static Builder newBuilder() {
        return new Builder();
    }

    public static final class Builder {
        private String clientId = "";

        public Builder setClientId(String clientId) { this.clientId = clientId; return this; }
        public HealthRequest build() { return new HealthRequest(this); }
    }
}
