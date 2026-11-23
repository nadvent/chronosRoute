FROM eclipse-temurin:21-jdk-alpine AS builder

RUN apk add --no-cache bash maven gcompat libstdc++

WORKDIR /build
COPY pom.xml mvnw ./
COPY .mvn ./.mvn
COPY src ./src

# Build package
RUN chmod +x ./mvnw && ./mvnw clean package -DskipTests

FROM eclipse-temurin:21-jre-alpine

WORKDIR /app
COPY --from=builder /build/target/*.jar app.jar

EXPOSE 8080

ENTRYPOINT ["java", "-Djdk.tracePinnedThreads=full", "-XX:+UseZGC", "-jar", "app.jar"]
