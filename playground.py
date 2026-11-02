from dotenv import load_dotenv
import os
from sqlalchemy import create_engine,text,Column,String,Integer
from sqlalchemy.orm import DeclarativeBase , sessionmaker
load_dotenv()
database_url=os.getenv("database_url")
print(database_url)

# creating the engine means the road to database
engine = create_engine(database_url)
with engine.connect() as conn:
  version = conn.execute(text("SELECT version()")).scalar()
  print(f"connected to {version.split(",")[0]}")


""""Declerative base is parent class from sqlalchemy that turns normal python class into database
table 
Declerative : You declear (describe) what a table look like 
Base : its the Parent class everything else built on top of this """

class Base(DeclarativeBase):
  pass

class StudentDB(Base):
  __tablename__ = "students_record"
  id = Column(String, primary_key=True )
  name = Column(String(50), nullable=False )
  age = Column(Integer,nullable=False)
  course = Column(String,nullable=False) 
  marks = Column(Integer,nullable=False)
  email = Column(String,unique=True,nullable=False)


# bind=engine -> Attach to: create the table inside this database (database ko url i.e engine ko  bhitra gaera table create garaune )
Base.metadata.create_all(bind=engine)

# step 4 creating the sessions
  # session is something where one visit,open,do work,commit , close
SessionLocal = sessionmaker(bind=engine)
db = SessionLocal()