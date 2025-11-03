from django.core.management.base import BaseCommand
from core.supabase_client import ping_supabase

class Command(BaseCommand):
    help = "Test Supabase connectivity"

    def handle(self, *args, **options):
        result = ping_supabase()
        if result.get("ok"):
            self.stdout.write(self.style.SUCCESS(
                f"Supabase OK via {result['method']}: {result['details']}"
            ))
        else:
            self.stderr.write(self.style.ERROR(
                f"Supabase FAIL via {result.get('method')}: {result.get('details')}"
            ))
            raise SystemExit(1)