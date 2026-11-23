package com.chronosroute.proto.v1;

public enum SolverStatus {
    SOLVER_STATUS_UNSPECIFIED(0),
    SOLVER_STATUS_OPTIMAL(1),
    SOLVER_STATUS_FEASIBLE(2),
    SOLVER_STATUS_TIMEOUT_BEST_EFFORT(3),
    SOLVER_STATUS_INFEASIBLE(4),
    SOLVER_STATUS_ERROR(5);

    private final int number;

    SolverStatus(int number) {
        this.number = number;
    }

    public int getNumber() {
        return number;
    }
}
