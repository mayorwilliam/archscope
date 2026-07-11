from shop.models import Customer


def customer_email(customer: Customer) -> str:
    return customer.email
