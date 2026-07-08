from .models import Post, User


def recent_posts_by(user: User) -> list[Post]:
    return sorted(user.posts, key=lambda p: p.id, reverse=True)
