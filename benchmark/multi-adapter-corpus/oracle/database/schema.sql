create table customers
( customer_id number primary key
, display_name varchar2(100)
, normalized_name varchar2(100) generated always as (upper(display_name)) virtual );

create table orders
( order_id number primary key
, customer_id number not null );

create or replace force view customer_orders as
select cus.customer_id
     , ord.order_id
from   customers cus
       join orders ord
            on ord.customer_id = cus.customer_id;
