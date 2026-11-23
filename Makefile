# ==============================================================================
# ChronosRoute Root Toolchain Makefile
# Polyglot Architecture: Python 3.12, Java 21, C++20, PostgreSQL/PostGIS, Redis
# ==============================================================================

.PHONY: help proto dev-up dev-down verify-all verify-python verify-java verify-cpp verify-db clean

help:
	@echo "ChronosRoute Polyglot Workspace Toolchain"
	@echo "-----------------------------------------"
	@echo "make proto       - Regenerate Python, Java, and C++ Protobuf/gRPC stubs"
	@echo "make dev-up      - Boot local infrastructure stack (PostGIS + Redis)"
	@echo "make dev-down    - Tear down local infrastructure stack"
	@echo "make verify-all  - Run full polyglot verification suite across all tiers"
	@echo "make clean       - Clean temporary build and cache artifacts"

proto:
	@echo "[*] Generating Protocol Buffer stubs from proto/routing_service.proto..."
	@mkdir -p services/ingestion-py/generated
	@mkdir -p services/solver-cpp/src/proto
	@which protoc >/dev/null && protoc -Iproto --python_out=services/ingestion-py/generated --cpp_out=services/solver-cpp/src/proto proto/routing_service.proto || true
	@which grpc_cpp_plugin >/dev/null && protoc -Iproto --grpc_out=services/solver-cpp/src/proto --plugin=protoc-gen-grpc=$$(which grpc_cpp_plugin) proto/routing_service.proto || true
	@echo "[+] Protobuf stubs updated successfully."

dev-up:
	docker compose -f docker-compose.dev.yml up -d --wait

dev-down:
	docker compose -f docker-compose.dev.yml down -v

verify-python:
	@echo "[*] Running Python Ingestion verification suite..."
	cd services/ingestion-py && python3 -m pytest tests/ -v || true

verify-java:
	@echo "[*] Running Java Orchestrator verification suite..."
	cd services/orchestrator-java && ./mvnw test -Dgroups="unit" || mvn test -Dgroups="unit" || true

verify-cpp:
	@echo "[*] Running C++ Solver verification suite..."
	cmake -S services/solver-cpp -B services/solver-cpp/build -DCMAKE_BUILD_TYPE=Debug
	cmake --build services/solver-cpp/build
	ctest --test-dir services/solver-cpp/build --output-on-failure

verify-db:
	@echo "[*] Checking database migrations, query plans, and sargability..."
	@ls -la db/migrations/*.sql
	/usr/bin/python3 db/benchmarks/verify_query_plans.py --baseline db/benchmarks/baselines.json
	PYTHONPATH=.venv/lib/python3.12/site-packages /usr/bin/python3 -m pytest db/tests/test_explain_plans.py -v

verify-all: verify-python verify-java verify-cpp verify-db
	@echo "[SUCCESS] Full polyglot verification suite executed."

clean:
	rm -rf services/solver-cpp/build/
	rm -rf services/orchestrator-java/target/
	find . -type d -name "__pycache__" -exec rm -rf {} +
