package com.chronosroute.proto.v1;

public enum StopType {
    STOP_TYPE_UNSPECIFIED(0),
    STOP_TYPE_PICKUP(1),
    STOP_TYPE_DROPOFF(2),
    STOP_TYPE_DEPOT(3);

    private final int number;

    StopType(int number) {
        this.number = number;
    }

    public int getNumber() {
        return number;
    }
}
