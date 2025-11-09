from django.contrib import admin
from .models import BulkResearchSession


@admin.register(BulkResearchSession)
class BulkResearchSessionAdmin(admin.ModelAdmin):
    list_display = ('id', 'user', 'keyword', 'desired_total', 'status', 'created_at', 'completed_at')
    list_filter = ('status',)
    search_fields = ('keyword', 'user__username', 'id')
    ordering = ('-created_at',)