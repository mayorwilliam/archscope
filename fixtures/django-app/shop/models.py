from django.db import models


class Team(models.Model):
    name = models.CharField(max_length=80)

    class Meta:
        db_table = "orgs_team"


class Customer(models.Model):
    email = models.EmailField()
    nick = models.CharField(max_length=30, null=True, db_column="nickname")
    team = models.ForeignKey(Team, on_delete=models.CASCADE, null=True)


class AbstractAudit(models.Model):
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        abstract = True
