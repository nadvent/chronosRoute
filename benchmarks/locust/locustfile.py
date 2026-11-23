from locust import HttpUser, task, between


class ChronosUser(HttpUser):
    wait_time = between(0.05, 0.2)

    @task
    def health_check(self):
        self.client.get("/health")
