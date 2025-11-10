from django.db import models
from django.contrib.auth.models import User

class BulkResearchSession(models.Model):
    STATUS_CHOICES = (
        ('ongoing', 'Ongoing'),
        ('completed', 'Completed'),
        ('failed', 'Failed'),
    )

    user = models.ForeignKey(User, on_delete=models.CASCADE, related_name='bulk_sessions')
    keyword = models.CharField(max_length=255)
    desired_total = models.PositiveIntegerField(default=20)
    status = models.CharField(max_length=20, choices=STATUS_CHOICES, default='ongoing')
    progress = models.JSONField(default=dict, blank=True)
    result_file = models.TextField(blank=True, default='')
    external_session_id = models.CharField(max_length=200, blank=True, null=True, unique=True)
    created_at = models.DateTimeField(auto_now_add=True)
    started_at = models.DateTimeField(null=True, blank=True)
    completed_at = models.DateTimeField(null=True, blank=True)

    def __str__(self):
        return f"{self.keyword} ({self.status})"

    @staticmethod
    def build_initial_progress(total: int):
        return {
            'search': {'total': total, 'remaining': total},
            'splitting': {'total': total, 'remaining': total},
            'demand': {'total': total, 'remaining': total},
            'keywords': {'total': total, 'remaining': total},
        }